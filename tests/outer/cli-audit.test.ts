/**
 * Contract tests for gated `codeflow audit`.
 *
 * Audit exists so a human (or an outer loop) can inspect a run that is stuck:
 * BLOCKED handoffs, stale active work, or a dead depth-0 runner with
 * nonterminal business state. A healthy run must be refused — an audit that
 * always answers becomes an unbounded content reader, and the whole point of
 * the metadata plane is that nobody outside the run ever reads prompts,
 * summaries, receipts, or event payloads. These tests pin both halves: the
 * gate (when audit answers at all) and the shape (identity-only fields).
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { finishHandoff, openHandoff, startHandoff } from "../../runtime/lib/handoff";
import { RunPaths } from "../../runtime/lib/paths";

const REPO = path.resolve(import.meta.dir, "..", "..");
const OUTER = path.join(REPO, "runtime", "bin", "codeflow");
const RUN_ID = "run-audit";

interface Result {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

function baseEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.CODEFLOW_RUN_ID;
	delete env.CODEFLOW_RUNS_DIR;
	return env;
}

function outer(args: string[], env: Record<string, string> = baseEnv()): Result {
	const spawned = Bun.spawnSync(["bash", OUTER, ...args], { env, timeout: 30_000 });
	return {
		exitCode: spawned.exitCode,
		stdout: spawned.stdout.toString(),
		stderr: spawned.stderr.toString(),
	};
}

const tmpDirs: string[] = [];
const sleepers: Bun.Subprocess[] = [];

function makeRunsDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-audit-"));
	tmpDirs.push(dir);
	return dir;
}

function spawnSleeper(): Bun.Subprocess {
	const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
	sleepers.push(proc);
	return proc;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function makeRun(): { dir: string; runDir: string; paths: RunPaths } {
	const dir = makeRunsDir();
	const runDir = path.join(dir, RUN_ID);
	fs.mkdirSync(runDir, { recursive: true });
	return { dir, runDir, paths: new RunPaths(dir, RUN_ID) };
}

function writeRunner(runDir: string, runner: Record<string, unknown>): void {
	fs.writeFileSync(path.join(runDir, "runner.json"), JSON.stringify(runner));
}

/** A live depth-0 runner with a fresh heartbeat: the healthy baseline. */
function liveRunner(runDir: string, pid: number): void {
	writeRunner(runDir, {
		pid,
		started_at: new Date().toISOString(),
		requirement: "audit fixture run",
		role: "planner",
	});
	const liveness = path.join(runDir, "liveness");
	fs.mkdirSync(liveness, { recursive: true });
	fs.writeFileSync(
		path.join(liveness, `${pid}--planner--0.json`),
		JSON.stringify({
			pid,
			role: "planner",
			depth: 0,
			status: "running",
			heartbeat_at: new Date().toISOString(),
		}),
	);
}

/** An active, running handoff started just now. */
function openActive(paths: RunPaths, body = "Goal: audit fixture\n"): string {
	const opened = openHandoff(paths, { role: "planner", depth: 0, body });
	startHandoff(paths, opened.handoff_id);
	return opened.handoff_id;
}

function finishBlocked(paths: RunPaths, handoffId: string, summary: string): void {
	finishHandoff(paths, {
		handoffId,
		status: "BLOCKED",
		summary,
		blockedReasons: ["PROVIDER_FAILURE"],
	});
}

function audit(args: string[], runsDir: string, extraEnv: Record<string, string> = {}): Result {
	return outer(["audit", ...args], { ...baseEnv(), CODEFLOW_RUNS_DIR: runsDir, ...extraEnv });
}

/** Exactly one JSON object: a second object (or prose) fails this parse. */
function parseSnapshot(stdout: string): Record<string, any> {
	return JSON.parse(stdout);
}

afterEach(() => {
	// No orphan sleepers may leak between test files.
	for (const proc of sleepers.splice(0)) {
		try {
			proc.kill();
		} catch {
			// Already dead.
		}
	}
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("audit health gate", () => {
	test("refuses a healthy run without --force", () => {
		const { dir, runDir, paths } = makeRun();
		liveRunner(runDir, spawnSleeper().pid);
		openActive(paths);

		const result = audit([RUN_ID], dir);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/refus|health/i);
		// A refusal must not leak a snapshot anyway.
		expect(result.stdout).not.toContain('"run_id"');
	});

	test("--force overrides the health gate and says so", () => {
		const { dir, runDir, paths } = makeRun();
		const sleeper = spawnSleeper();
		liveRunner(runDir, sleeper.pid);
		openActive(paths);

		const result = audit([RUN_ID, "--force"], dir);
		expect(result.exitCode).toBe(0);
		const body = parseSnapshot(result.stdout);
		expect(body.forced).toBe(true);
		expect(body.trigger).toBe("forced");
			// A sleep fixture passes kill0 but cannot match the pi cmdline, so the
			// safe liveness verdict is UNKNOWN; audit must never promote it to ALIVE.
			const agent = (body.agents ?? []).find((entry: any) => entry.pid === sleeper.pid);
			expect(agent?.verdict).toBe("UNKNOWN");
	});
});

describe("audit triggers without --force", () => {
	test("a BLOCKED handoff allows audit with trigger blocked", () => {
		const { dir, runDir, paths } = makeRun();
		liveRunner(runDir, spawnSleeper().pid);
		finishBlocked(paths, openActive(paths), "provider died");

		const result = audit([RUN_ID], dir);
		expect(result.exitCode).toBe(0);
		const body = parseSnapshot(result.stdout);
		expect(body.trigger).toBe("blocked");
		expect(body.forced).toBe(false);
		expect(body.handoffs[0].blocked_reasons).toContain("PROVIDER_FAILURE");
	});

	test("stale active work allows audit with trigger stale_active", async () => {
		const { dir, runDir, paths } = makeRun();
		liveRunner(runDir, spawnSleeper().pid);
		openActive(paths);
		// The threshold is one second and staleness is age strictly past it, so
		// two-plus seconds of age makes the verdict deterministic.
		await Bun.sleep(2_200);

		const result = audit([RUN_ID], dir, { CODEFLOW_HANDOFF_TIMEOUT_SECONDS: "1" });
		expect(result.exitCode).toBe(0);
		const body = parseSnapshot(result.stdout);
		expect(body.trigger).toBe("stale_active");
		expect(body.handoffs[0].stale).toBe(true);
		expect(body.handoffs[0].age_seconds).toBeGreaterThanOrEqual(1);
	});

	test("a dead depth-0 runner with unfinished work allows audit", async () => {
		const { dir, runDir, paths } = makeRun();
		const sleeper = spawnSleeper();
		writeRunner(runDir, {
			pid: sleeper.pid,
			started_at: new Date().toISOString(),
			requirement: "audit fixture run",
			role: "planner",
		});
		const pid = sleeper.pid;
		sleeper.kill();
		await sleeper.exited;
		expect(pidAlive(pid)).toBe(false);
		openActive(paths);

		const result = audit([RUN_ID], dir);
		expect(result.exitCode).toBe(0);
		const body = parseSnapshot(result.stdout);
		expect(body.trigger).toBe("dead_runner");
		expect(body.run_status).toBe("finished");
	});

	test("an active handoff with no runner.json at all allows audit", () => {
		const { dir, paths } = makeRun();
		openActive(paths);

		const result = audit([RUN_ID], dir);
		expect(result.exitCode).toBe(0);
		const body = parseSnapshot(result.stdout);
		expect(body.trigger).toBe("missing_runner");
		expect(body.run_status).toBe("unknown");
	});
});

describe("audit --force composition", () => {
	test("--force on a blocked run keeps the blocked trigger", () => {
		const { dir, runDir, paths } = makeRun();
		liveRunner(runDir, spawnSleeper().pid);
		finishBlocked(paths, openActive(paths), "provider died");

		const result = audit([RUN_ID, "--force"], dir);
		expect(result.exitCode).toBe(0);
		const body = parseSnapshot(result.stdout);
		expect(body.trigger).toBe("blocked");
		expect(body.forced).toBe(true);
	});
});

describe("audit output is bounded identity-only metadata", () => {
	test("no goal, summary, or event payload content escapes the snapshot", () => {
		const { dir, runDir, paths } = makeRun();
		liveRunner(runDir, spawnSleeper().pid);
		const handoffId = openActive(paths, "Goal: AUDIT-CANARY-GOAL\nScope: src/canary.ts\n");
		finishBlocked(paths, handoffId, "AUDIT-CANARY-SUMMARY");
		// A delivered event whose payload carries the third canary: audit may
		// report the event's identity but never its body.
		const events = path.join(runDir, "events");
		fs.mkdirSync(events, { recursive: true });
		fs.writeFileSync(
			path.join(events, "00009--planner--delegation_delivered--DELIVERED.json"),
			JSON.stringify({ detail: "AUDIT-CANARY-EVENT" }) + "\n",
		);

		const result = audit([RUN_ID], dir);
		expect(result.exitCode).toBe(0);
		for (const canary of ["AUDIT-CANARY-GOAL", "AUDIT-CANARY-SUMMARY", "AUDIT-CANARY-EVENT"]) {
			expect(result.stdout).not.toContain(canary);
		}

		const body = parseSnapshot(result.stdout);
		const topLevel = new Set([
			"run_id",
			"trigger",
			"run_status",
			"forced",
			"handoffs",
			"agents",
			"last_event",
		]);
		for (const key of Object.keys(body)) {
			expect(topLevel.has(key)).toBe(true);
		}
		for (const key of ["run_id", "trigger", "run_status", "forced", "handoffs"]) {
			expect(body).toHaveProperty(key);
		}
		expect(body.run_id).toBe(RUN_ID);

		const handoffKeys = new Set([
			"id",
			"role",
			"depth",
			"status",
			"result",
			"blocked_reasons",
			"stale",
			"age_seconds",
		]);
		expect(Array.isArray(body.handoffs)).toBe(true);
		expect(body.handoffs.length).toBeGreaterThan(0);
		for (const entry of body.handoffs) {
			for (const key of Object.keys(entry)) {
				expect(handoffKeys.has(key)).toBe(true);
			}
		}

		const agentKeys = new Set(["pid", "role", "depth", "verdict", "heartbeat_age_seconds"]);
		for (const entry of body.agents ?? []) {
			for (const key of Object.keys(entry)) {
				expect(agentKeys.has(key)).toBe(true);
			}
			expect(["ALIVE", "DEAD", "UNKNOWN"]).toContain(entry.verdict);
		}

		const eventKeys = new Set(["seq", "subject", "kind", "status"]);
		if (body.last_event !== undefined && body.last_event !== null) {
			for (const key of Object.keys(body.last_event)) {
				expect(eventKeys.has(key)).toBe(true);
			}
		}
	});
});
