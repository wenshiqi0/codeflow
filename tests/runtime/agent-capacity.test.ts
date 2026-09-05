import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_MAX_CONCURRENT_AGENTS, closeAgentSubtree, descendantAgentPids, maxConcurrentAgents, reserveAgentSlot, validateAgentStartup,
} from "../../runtime/lib/agent-capacity";
import { RunPaths } from "../../runtime/lib/paths";

const temporaryRoots: string[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];
const originalLimit = process.env.CODEFLOW_MAX_CONCURRENT_AGENTS;
const capacityModule = path.resolve(import.meta.dir, "../../runtime/lib/agent-capacity.ts");
const pathsModule = path.resolve(import.meta.dir, "../../runtime/lib/paths.ts");

afterEach(async () => {
	for (const child of processes.splice(0)) {
		if (child.exitCode === null) child.kill();
		await child.exited;
	}
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	if (originalLimit === undefined) delete process.env.CODEFLOW_MAX_CONCURRENT_AGENTS;
	else process.env.CODEFLOW_MAX_CONCURRENT_AGENTS = originalLimit;
});

function fixture(limit = 8): RunPaths {
	process.env.CODEFLOW_MAX_CONCURRENT_AGENTS = String(limit);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-agent-capacity-"));
	temporaryRoots.push(root);
	return new RunPaths(root, "task-capacity");
}

function slots(paths: RunPaths): string { return path.join(paths.runDir, ".agent-slots"); }

function seedLease(paths: RunPaths, ownerPid: number, pid: number | null) {
	const dir = path.join(slots(paths), "1");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "lease.json"), JSON.stringify({
		execution_id: "stale", parent_execution_id: "root", token: "stale-token", owner_pid: ownerPid, pid,
	}));
}

async function exitedPid(): Promise<number> {
	const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "pipe" });
	processes.push(child);
	await child.exited;
	expect(() => process.kill(child.pid, 0)).toThrow();
	return child.pid;
}

function idlePid(): number {
	const child = Bun.spawn([process.execPath, "-e", "await new Response(Bun.stdin.stream()).text()"], {
		stdin: "pipe", stdout: "ignore", stderr: "pipe",
	});
	processes.push(child);
	return child.pid;
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	let text = "";
	try {
		while (!text.includes("\n")) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error("capacity contender ended without a result");
			text += new TextDecoder().decode(chunk.value);
		}
		return text.split("\n")[0];
	} finally { reader.releaseLock(); }
}

describe("Task-wide Agent process capacity", () => {
	test("validates a positive limit and counts the root", () => {
		delete process.env.CODEFLOW_MAX_CONCURRENT_AGENTS;
		expect(maxConcurrentAgents()).toBe(DEFAULT_MAX_CONCURRENT_AGENTS);
		for (const value of ["0", "-1", "", "1.5", "Infinity", "abc", "9007199254740992"]) {
			expect(() => maxConcurrentAgents(value)).toThrow("positive integer");
		}
		const paths = fixture(1);
		expect(() => reserveAgentSlot(paths, "child", "root")).toThrow("including root");
	});

	test("all recursion levels share capacity and released slots can be reused", () => {
		const paths = fixture(3);
		const child = reserveAgentSlot(paths, "child", "root");
		const grandchild = reserveAgentSlot(paths, "grandchild", "child");
		expect(() => reserveAgentSlot(paths, "other", "root")).toThrow("Continue useful local work");
		grandchild.release();
		const greatGrandchild = reserveAgentSlot(paths, "great-grandchild", "grandchild");
		greatGrandchild.release();
		child.release();
		expect(fs.readdirSync(slots(paths)).filter((name) => /^\d+$/.test(name))).toEqual([]);
	});

	test("live owners retain pending and attached leases", () => {
		const paths = fixture(2);
		const child = reserveAgentSlot(paths, "child", "root");
		expect(() => reserveAgentSlot(paths, "other", "root")).toThrow("capacity reached");
		child.attach(process.pid);
		expect(() => reserveAgentSlot(paths, "other", "root")).toThrow("capacity reached");
		child.release();
	});

	test("dead owners do not free a still-live orphan", async () => {
		const paths = fixture(2);
		seedLease(paths, await exitedPid(), process.pid);
		expect(() => reserveAgentSlot(paths, "other", "root")).toThrow("capacity reached");
		expect(descendantAgentPids(paths, "root")).toEqual([process.pid]);
	});

	test("reclaims leases only after both owner and attached process are dead", async () => {
		const paths = fixture(2);
		const dead = await exitedPid();
		seedLease(paths, dead, dead);
		const lease = reserveAgentSlot(paths, "replacement", "root");
		lease.attach(process.pid);
		expect(descendantAgentPids(paths, "root")).toEqual([process.pid]);
		lease.release();
	});

	test("a dead owner with no attached PID is uncertain, not safe to reclaim", async () => {
		const paths = fixture(2);
		seedLease(paths, await exitedPid(), null);
		expect(() => reserveAgentSlot(paths, "replacement", "root")).toThrow("capacity reached");
	});

	test("dead descendant PIDs do not block parent closure", async () => {
		const paths = fixture(2);
		seedLease(paths, process.pid, await exitedPid());
		expect(descendantAgentPids(paths, "root")).toEqual([]);
	});

	test("uncertain publication and invalid PIDs fail closed", () => {
		const paths = fixture(2);
		fs.mkdirSync(path.join(slots(paths), "1"), { recursive: true });
		expect(() => reserveAgentSlot(paths, "child", "root")).toThrow("capacity reached");
		seedLease(paths, 0, null);
		expect(() => reserveAgentSlot(paths, "child", "root")).toThrow("lease is invalid");
		expect(fs.existsSync(path.join(slots(paths), "1"))).toBe(true);
	});

	test("does not steal an abandoned metadata lock", () => {
		const paths = fixture(2);
		fs.mkdirSync(slots(paths), { recursive: true });
		const lock = path.join(slots(paths), ".lock");
		fs.writeFileSync(lock, "unknown owner");
		expect(() => reserveAgentSlot(paths, "child", "root")).toThrow("stop the Task and inspect");
		expect(fs.readFileSync(lock, "utf8")).toBe("unknown owner");
	});

	test("publication failures leave no acquired slot or mutex behind", () => {
		const paths = fixture(2);
		fs.mkdirSync(slots(paths), { recursive: true });
		fs.writeFileSync(path.join(slots(paths), "parents.json"), "{}");
		expect(() => reserveAgentSlot(paths, "child", "root")).toThrow("parent index is invalid");
		expect(fs.readdirSync(slots(paths))).toEqual(["parents.json"]);
	});

	test("old leases cannot attach to or remove a later reservation", () => {
		const paths = fixture(2);
		const old = reserveAgentSlot(paths, "child", "root");
		old.release();
		const current = reserveAgentSlot(paths, "child", "root");
		current.attach(process.pid);
		old.release();
		expect(() => old.attach(process.pid)).toThrow("no longer owned");
		expect(() => current.attach(-1)).toThrow("positive process id");
		expect(descendantAgentPids(paths, "root")).toEqual([process.pid]);
		current.release();
	});

	test("descendant lookup isolates subtrees and preserves ancestry after parent exit", () => {
		const paths = fixture(5);
		const parent = reserveAgentSlot(paths, "parent", "root");
		const grandchild = reserveAgentSlot(paths, "grandchild", "parent");
		const sibling = reserveAgentSlot(paths, "sibling", "root");
		const pending = reserveAgentSlot(paths, "pending", "grandchild");
		const parentPid = idlePid();
		const grandchildPid = idlePid();
		const siblingPid = idlePid();
		parent.attach(parentPid);
		grandchild.attach(grandchildPid);
		sibling.attach(siblingPid);
		expect(descendantAgentPids(paths, "root").sort()).toEqual([parentPid, grandchildPid, siblingPid].sort());
		expect(descendantAgentPids(paths, "parent")).toEqual([grandchildPid]);
		expect(descendantAgentPids(paths, "grandchild")).toEqual([]);
		parent.release();
		expect(descendantAgentPids(paths, "root").sort()).toEqual([grandchildPid, siblingPid].sort());
		expect(descendantAgentPids(paths, "parent")).toEqual([grandchildPid]);
		grandchild.release(); sibling.release(); pending.release();
	});

	test("subtree closure fences future reservations at every depth, not siblings", () => {
		const paths = fixture(5);
		const parent = reserveAgentSlot(paths, "parent", "root");
		const grandchild = reserveAgentSlot(paths, "grandchild", "parent");
		closeAgentSubtree(paths, "parent");
		closeAgentSubtree(paths, "parent");
		expect(() => reserveAgentSlot(paths, "new-child", "parent")).toThrow("subtree is closed");
		expect(() => reserveAgentSlot(paths, "great-grandchild", "grandchild")).toThrow("subtree is closed");
		grandchild.release(); parent.release();
		expect(() => reserveAgentSlot(paths, "later", "grandchild")).toThrow("subtree is closed");
		reserveAgentSlot(paths, "sibling", "root").release();
		expect(JSON.parse(fs.readFileSync(path.join(slots(paths), "closed.json"), "utf8"))).toEqual(["parent"]);
	});

	test("a pending reservation publishes its PID before rejecting a closed ancestor", () => {
		const paths = fixture(4);
		const parent = reserveAgentSlot(paths, "parent", "root");
		const pending = reserveAgentSlot(paths, "pending", "parent");
		closeAgentSubtree(paths, "parent");
		expect(() => pending.attach(process.pid)).toThrow("subtree is closed");
		expect(descendantAgentPids(paths, "parent")).toEqual([process.pid]);
		expect(descendantAgentPids(paths, "root")).toEqual([process.pid]);
		pending.release(); parent.release();
		expect(descendantAgentPids(paths, "root")).toEqual([]);
	});

	test("closing the root before any spawn prevents all new descendants", () => {
		const paths = fixture();
		closeAgentSubtree(paths, "root");
		expect(() => reserveAgentSlot(paths, "first", "root")).toThrow("subtree is closed");
		expect(descendantAgentPids(paths, "root")).toEqual([]);
	});

	test("Child startup self-registers before parent attachment and rejects PID replacement", () => {
		const paths = fixture(2);
		const lease = reserveAgentSlot(paths, "child", "root");
		validateAgentStartup(paths, "child");
		expect(descendantAgentPids(paths, "root")).toEqual([process.pid]);
		lease.attach(process.pid);
		expect(() => lease.attach(process.pid + 1)).toThrow("already has an attached process");
		expect(() => validateAgentStartup(paths, "child", process.pid + 1)).toThrow("different process");
		lease.release();
	});

	test("Child startup without a lease fails before starting work", () => {
		const paths = fixture();
		expect(() => validateAgentStartup(paths, "missing")).toThrow("no unique capacity lease");
		expect(() => validateAgentStartup(paths, "missing", 0)).toThrow("positive process id");
		expect(descendantAgentPids(paths, "root")).toEqual([]);
	});

	test("orphaned Child startup publishes its PID before rejecting a dead owner", async () => {
		const paths = fixture(2);
		seedLease(paths, await exitedPid(), null);
		expect(() => validateAgentStartup(paths, "stale")).toThrow("owner is no longer alive");
		expect(descendantAgentPids(paths, "root")).toEqual([process.pid]);
	});

	test("Child startup publishes its PID before rejecting a closed ancestor", () => {
		const paths = fixture(3);
		const parent = reserveAgentSlot(paths, "parent", "root");
		const child = reserveAgentSlot(paths, "child", "parent");
		closeAgentSubtree(paths, "root");
		expect(() => validateAgentStartup(paths, "child")).toThrow("subtree is closed");
		expect(descendantAgentPids(paths, "root")).toEqual([process.pid]);
		child.release(); parent.release();
	});

	test("real concurrent parents cannot reclaim each other's replacement leases", async () => {
		const paths = fixture(4);
		const dead = await exitedPid();
		seedLease(paths, dead, dead);
		const contenders = Array.from({ length: 12 }, (_, index) => Bun.spawn([
			process.execPath, "-e", `
				import { reserveAgentSlot } from ${JSON.stringify(capacityModule)};
				import { RunPaths } from ${JSON.stringify(pathsModule)};
				let lease;
				try {
					lease = reserveAgentSlot(new RunPaths(${JSON.stringify(paths.code)}, ${JSON.stringify(paths.runId)}), "contender-${index}", "parent-${index}");
					lease.attach(process.pid);
					console.log(JSON.stringify({ reserved: true, pid: process.pid }));
				} catch (error) { console.log(JSON.stringify({ reserved: false, message: error.message })); }
				await new Response(Bun.stdin.stream()).text();
				lease?.release();
			`,
		], { env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
		processes.push(...contenders);
		const results = await Promise.all(contenders.map(async (child) => JSON.parse(await firstLine(child.stdout))));
		expect(results.filter((result) => result.reserved)).toHaveLength(3);
		for (const result of results.filter((entry) => !entry.reserved)) expect(result.message).toContain("capacity reached");
		const occupied = fs.readdirSync(slots(paths)).filter((name) => /^\d+$/.test(name));
		expect(occupied).toHaveLength(3);
		const pids = occupied.map((name) => JSON.parse(fs.readFileSync(path.join(slots(paths), name, "lease.json"), "utf8")).pid);
		expect(pids.sort()).toEqual(results.filter((result) => result.reserved).map((result) => result.pid).sort());
		for (const child of contenders) child.stdin.end();
		expect(await Promise.all(contenders.map((child) => child.exited))).toEqual(Array(12).fill(0));
		expect(fs.readdirSync(slots(paths)).filter((name) => /^\d+$/.test(name))).toEqual([]);
	});
});
