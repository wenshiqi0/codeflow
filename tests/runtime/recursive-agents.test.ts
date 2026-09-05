import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commitmentHistory, loadTerminalReceipt } from "../../runtime/lib/commitment";
import { RunPaths } from "../../runtime/lib/paths";
import { scan } from "../../runtime/lib/wait";

const repository = path.resolve(import.meta.dir, "../..");
const directories: string[] = [];
const liveProcesses = new Set<Bun.Subprocess>();
const knownPids = new Set<number>();
interface TraceEvent {
	kind: string;
	depth: number;
	pid: number;
	at: number;
	calls?: number;
	execution_id: string;
	commitment_id: string | null;
	child_execution_id?: string;
	action?: string;
	is_error?: boolean;
	result?: string;
	model?: string;
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

function events(dir: string, depth: number): TraceEvent[] {
	try {
		return fs.readFileSync(path.join(dir, `depth-${depth}.jsonl`), "utf8")
			.split("\n").filter(Boolean).flatMap((line) => {
				try {
					const event = JSON.parse(line) as TraceEvent;
					knownPids.add(event.pid);
					return [event];
				} catch { return []; } // A concurrent append may be incomplete until the next read.
			});
	} catch { return []; }
}

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("recursive fixture condition timed out");
		await Bun.sleep(25);
	}
}

afterEach(async () => {
	// Recover even partially started trees when a regression prevents depth 3.
	for (const dir of directories) for (let depth = 0; depth <= 3; depth++) events(dir, depth);
	for (const child of liveProcesses) {
		if (child.exitCode !== null) continue;
		try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
	}
	await Promise.all([...liveProcesses].map((child) => child.exited));
	liveProcesses.clear();
	for (const pid of knownPids) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
	knownPids.clear();
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function launch(resume?: { dir: string; taskId: string }) {
	const dir = resume?.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-recursive-agents-"));
	if (!resume) {
		directories.push(dir);
		fs.mkdirSync(path.join(dir, "pi"));
		fs.writeFileSync(path.join(dir, "pi/settings.json"), JSON.stringify({ retry: { enabled: false } }));
	}
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("CODEFLOW_")) delete env[key];
	const child = Bun.spawn([
		process.execPath, path.join(repository, "runtime/cli/run.ts"),
		...(resume ? ["resume", resume.taskId]
			: ["exec", "--model", "codeflow-recursive-offline/agent", "Prove recursive Agent execution and feedback"]),
	], {
		cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
		env: { ...env,
			CODEFLOW_RUNS_DIR: path.join(dir, "runs"),
			CODEFLOW_RECURSIVE_TEST_DIR: dir,
			CODEFLOW_PI_CLI: path.join(repository, "tests/fixtures/runtime/recursive-agent.ts"),
			// Resume accepts no model flag; supply the same explicit offline override
			// through the documented run-scoped environment rather than mutate config.
			CODEFLOW_AGENT_MODEL: "codeflow-recursive-offline/agent",
		},
	});
	liveProcesses.add(child);
	const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	return { dir, child, output };
}

function runPaths(dir: string): RunPaths {
	const tasks = fs.readdirSync(path.join(dir, "runs")).filter((name) => name.startsWith("task-"));
	expect(tasks).toHaveLength(1);
	return new RunPaths(path.join(dir, "runs"), tasks[0]);
}

describe("recursive real Pi Agents with deterministic offline provider", () => {
	test("production delegation reaches depth 3 and bubbles terminal Receipts upward without idle provider calls", async () => {
		const run = launch();
		await until(() => events(run.dir, 3).some((event) => event.kind === "leaf_waiting"));
		await until(() => [0, 1, 2].every((depth) => events(run.dir, depth).some((event) => event.kind === "parent_idle")));
		// Allow the final leaf Claim notification to reach its direct Parent, then
		// observe a full two feedback ticks with no new model request at any ancestor.
		await Bun.sleep(500);
		const callsBefore = [0, 1, 2].map((depth) => events(run.dir, depth).filter((event) => event.kind === "provider_call").length);
		await Bun.sleep(650);
		expect([0, 1, 2].map((depth) => events(run.dir, depth).filter((event) => event.kind === "provider_call").length))
			.toEqual(callsBefore);
		fs.writeFileSync(path.join(run.dir, "release-leaf"), "ready\n");
		await until(() => run.child.exitCode !== null);
		const code = await run.child.exited;
		const [stdout, stderr] = await run.output;
		expect(stderr).not.toContain("Extension error");
		expect(stdout).not.toContain("No more responses");
		expect(code).toBe(0);
		const paths = runPaths(run.dir);
		const history = commitmentHistory(paths);
		expect(history).toHaveLength(4);
		const registrations = [0, 1, 2, 3].map((depth) => events(run.dir, depth).find((event) => event.kind === "registered")!);
		expect(new Set(registrations.map((event) => event.pid)).size).toBe(4);
		for (let depth = 0; depth <= 3; depth++) {
			const trace = events(run.dir, depth);
			expect(trace.filter((event) => event.kind === "tool_result" && event.is_error)).toEqual([]);
			expect(registrations[depth].model).toBe("codeflow-recursive-offline/agent");
			const commitment = history.find((view) => view.commitment.worker_execution_id === registrations[depth].execution_id)!.commitment;
			expect(loadTerminalReceipt(paths, commitment.id)?.status).toBe("completed");
			if (depth === 0) expect(commitment.parent_commitment_id).toBeNull();
			else {
				const parent = history.find((view) => view.commitment.worker_execution_id === registrations[depth - 1].execution_id)!.commitment;
				expect(commitment.parent_commitment_id).toBe(parent.id);
				expect(loadTerminalReceipt(paths, parent.id)!.seq).toBeGreaterThan(loadTerminalReceipt(paths, commitment.id)!.seq);
			}
			if (depth < 3) {
				expect(trace.some((event) => event.kind === "tool_result" && event.action === "delegate" && !event.is_error)).toBe(true);
				expect(trace.some((event) => event.kind === "child_end_received"
					&& event.child_execution_id === registrations[depth + 1].execution_id)).toBe(true);
			}
		}
		await until(() => registrations.every((event) => !alive(event.pid)));
	}, 25_000);

	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		test(`${signal === "SIGTERM" ? "Root cancellation" : "Abrupt Root crash"} reaps every descendant without fabricating terminal Receipts`, async () => {
			const run = launch();
			await until(() => events(run.dir, 3).some((event) => event.kind === "leaf_waiting"));
			const registrations = [0, 1, 2, 3].map((depth) => events(run.dir, depth).find((event) => event.kind === "registered")!);
			expect(registrations).toHaveLength(4);
			// Signal only the Root Pi. SIGTERM exercises integrated graceful teardown;
			// SIGKILL skips Root extension cleanup, proving the outer supervisor reaps
			// its execution group and drains pipes even after an abrupt Root crash.
			process.kill(registrations[0].pid, signal);
			await until(() => registrations.every((event) => !alive(event.pid)));
			await until(() => run.child.exitCode !== null);
			expect(await run.child.exited).not.toBe(0);
			const history = commitmentHistory(runPaths(run.dir));
			expect(history).toHaveLength(4);
			expect(history.every((view) => view.folded.terminal === null)).toBe(true);
			await run.output;
		}, 25_000);
	}

	test("explicit CLI resume after Root crash recovers the same four nested Commitments", async () => {
		const initial = launch();
		await until(() => events(initial.dir, 3).some((event) => event.kind === "leaf_waiting"));
		const paths = runPaths(initial.dir);
		const original = commitmentHistory(paths).map((view) => view.commitment);
		expect(original).toHaveLength(4);
		const initialRegistrations = [0, 1, 2, 3].map((depth) => events(initial.dir, depth).find((event) => event.kind === "registered")!);
		process.kill(initialRegistrations[0].pid, "SIGKILL");
		await until(() => initialRegistrations.every((event) => !alive(event.pid)));
		await until(() => initial.child.exitCode !== null);
		expect(await initial.child.exited).not.toBe(0);
		await initial.output;
		expect(commitmentHistory(paths).every((view) => view.folded.terminal === null && view.pid === null)).toBe(true);
		const callsBeforeResume = [0, 1, 2, 3].map((depth) => events(initial.dir, depth).filter((event) => event.kind === "provider_call").length);
		await Bun.sleep(200);
		expect([0, 1, 2, 3].map((depth) => events(initial.dir, depth).filter((event) => event.kind === "provider_call").length))
			.toEqual(callsBeforeResume);
		fs.writeFileSync(path.join(initial.dir, "release-leaf"), "ready after explicit resume\n");
		const resumed = launch({ dir: initial.dir, taskId: paths.runId });
		await until(() => resumed.child.exitCode !== null);
		const [stdout, stderr] = await resumed.output;
		expect(stderr).not.toContain("Extension error");
		expect(stdout).not.toContain("No more responses");
		expect(await resumed.child.exited).toBe(0);
		const completed = commitmentHistory(paths);
		expect(completed.map((view) => view.commitment)).toEqual(original);
		expect(completed.every((view) => view.folded.terminal?.status === "completed")).toBe(true);
		expect(scan(paths.events, 0, ["run_resumed"]).events).toHaveLength(1);
		expect(scan(paths.events, 0, ["commitment_resumed"]).events).toHaveLength(4);
		for (let depth = 0; depth <= 3; depth++) {
			const registrations = events(initial.dir, depth).filter((event) => event.kind === "registered");
			expect(registrations).toHaveLength(2);
			const restored = registrations[1];
			expect(restored.commitment_id).toBe(original[depth].id);
			expect(restored.execution_id).not.toBe(initialRegistrations[depth].execution_id);
			expect(restored.model).toBe("codeflow-recursive-offline/agent");
			expect(events(initial.dir, depth).filter((event) => event.execution_id === restored.execution_id
				&& event.kind === "tool_result" && (event.is_error || event.action === "claim"))).toEqual([]);
		}
	}, 25_000);
});
