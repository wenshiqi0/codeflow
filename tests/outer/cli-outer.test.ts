/**
 * Contract tests for the two-binary command surface.
 *
 * The inner/outer ring boundary is enforced by process environment, not by
 * documentation. The outer `codeflow` binary owns exec/ls/sub/stop/memo/audit
 * and must refuse the mechanical inner verbs; the inner `code-agent` binary
 * owns delegate/handoff/facts/check/roster and refuses to run without
 * CODEFLOW_RUN_ID in its environment. A boundary kept only in docs erodes
 * silently — a role that can reach the state plane directly bypasses every
 * gate the loop relies on. These tests make any such leak a loud failure.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dir, "..", "..");
const OUTER = path.join(REPO, "runtime", "bin", "codeflow");
const INNER = path.join(REPO, "runtime", "bin", "code-agent");

interface Result {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

/**
 * This session runs inside a codeflow run, so CODEFLOW_RUN_ID is set in the
 * inherited environment. The gate tests must control both run variables
 * themselves — without this, "refuses outside a run" would test nothing.
 */
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

function inner(args: string[], env: Record<string, string> = baseEnv()): Result {
	const spawned = Bun.spawnSync(["bash", INNER, ...args], { env, timeout: 30_000 });
	return {
		exitCode: spawned.exitCode,
		stdout: spawned.stdout.toString(),
		stderr: spawned.stderr.toString(),
	};
}

const tmpDirs: string[] = [];
const sleepers: Bun.Subprocess[] = [];

function makeRunsDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-outer-"));
	tmpDirs.push(dir);
	return dir;
}

function spawnSleeper(): Bun.Subprocess {
	const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
	sleepers.push(proc);
	return proc;
}

function writeRunner(runDir: string, runner: Record<string, unknown>): void {
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(path.join(runDir, "runner.json"), JSON.stringify(runner));
}

/**
 * The three run shapes `ls` and `stop` must distinguish: a live runner, a
 * runner whose pid is dead (liveness recorded the exit), and a directory
 * with no metadata at all.
 */
function buildRunsDir(): { dir: string; sleeper: Bun.Subprocess } {
	const dir = makeRunsDir();
	const sleeper = spawnSleeper();

	writeRunner(path.join(dir, "run-running"), {
		pid: sleeper.pid,
		started_at: new Date().toISOString(),
		requirement: "r".repeat(100),
	});

	const finished = path.join(dir, "run-finished");
	writeRunner(finished, {
		pid: 424242,
		started_at: "2026-01-01T00:00:00Z",
		requirement: "old run",
	});
	fs.mkdirSync(path.join(finished, "liveness"), { recursive: true });
	fs.writeFileSync(
		path.join(finished, "liveness", "424242--planner--0.json"),
		JSON.stringify({ status: "exited", exited_at: "2026-01-01T00:01:00Z" }),
	);

	fs.mkdirSync(path.join(dir, "run-bare"), { recursive: true });
	return { dir, sleeper };
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

afterEach(() => {
	// No orphan sleepers may leak between test files.
	for (const proc of sleepers.splice(0)) {
		try {
			proc.kill();
		} catch {
			// Already dead — e.g. `codeflow stop` did its job.
		}
	}
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("P1: outer rejects inner verbs", () => {
	for (const verb of ["handoff", "facts", "source-check", "test-patch", "agents", "run"]) {
		test(`codeflow ${verb} is not an outer command`, () => {
			const result = outer([verb]);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr.trim()).not.toBe("");
		});
	}
});

describe("P2: outer rejects removed verbs", () => {
	// The old bare `codeflow "<req>"` pi passthrough is gone, so a nonsense
	// verb must fail loudly rather than reach a model.
	for (const verb of ["wait", "probe", "agent-status", "command", "frobnicate-not-a-verb"]) {
		test(`codeflow ${verb} is gone`, () => {
			const result = outer([verb]);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr.trim()).not.toBe("");
		});
	}
});

describe("P3: outer help", () => {
	test("--help lists the outer vocabulary", () => {
		const result = outer(["--help"]);
		expect(result.exitCode).toBe(0);
		for (const word of ["exec", "ls", "sub", "stop", "memo", "audit", "usage"]) {
			expect(result.stdout).toContain(word);
		}
	});
});

describe("P4: bare outer invocation", () => {
	test("no args prints usage and fails", () => {
		const result = outer([]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/usage/i);
	});
});

describe("P5: memo exists but refuses; audit is gated", () => {
	test("memo is declared, not implemented", () => {
		const result = outer(["memo", "run-x", "hello"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/not implement/i);
	});

	// audit is implemented but gated: it refuses healthy runs and demands a
	// real run id. The full audit contract lives in cli-audit.test.ts; here we
	// only pin the command surface so the verb cannot drift back to a stub.
	test("audit without a run id fails", () => {
		const env = { ...baseEnv(), CODEFLOW_RUNS_DIR: makeRunsDir() };
		const result = outer(["audit"], env);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.trim()).not.toBe("");
	});

	test("audit rejects an unknown run id", () => {
		const env = { ...baseEnv(), CODEFLOW_RUNS_DIR: makeRunsDir() };
		const result = outer(["audit", "no-such-run"], env);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/no such run|unknown run|not found/i);
	});

	test("audit rejects unknown options", () => {
		const env = { ...baseEnv(), CODEFLOW_RUNS_DIR: makeRunsDir() };
		const result = outer(["audit", "no-such-run", "--bogus"], env);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/unknown option|bogus/i);
	});

	test("usage reports per-round and per-model totals from the live ledger", () => {
		const runsDir = makeRunsDir();
		const runDir = path.join(runsDir, "run-usage");
		fs.mkdirSync(runDir, { recursive: true });
		const record = {
			schema_version: 1,
			at: "2026-01-01T00:00:00Z",
			run_id: "run-usage",
			role: "coder",
			depth: 1,
			handoff_id: "h1",
			goal_id: "g1",
			lane: "code",
			turn: 1,
			provider: "p",
			model: "m",
			response_model: "m",
			usage: {
				input: 1,
				output: 2,
				cache_read: 3,
				cache_write: 4,
				reasoning: 5,
				total_tokens: 10,
				cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 },
			},
		};
		fs.writeFileSync(path.join(runDir, "usage.jsonl"), `${JSON.stringify(record)}\n`);
		const result = outer(["usage", "run-usage"], { ...baseEnv(), CODEFLOW_RUNS_DIR: runsDir });
		expect(result.exitCode).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.records).toHaveLength(1);
		expect(report.models[0]).toMatchObject({ model: "p/m", calls: 1, total_tokens: 10 });
		expect(report.total).toMatchObject({ calls: 1, total_tokens: 10 });
	});
});

describe("P6/P7: inner gate", () => {
	test("code-agent refuses outside a run", () => {
		const result = inner(["handoff", "list"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("CODEFLOW_RUN_ID");
	});

	test("code-agent passes inside a run", () => {
		const env = {
			...baseEnv(),
			CODEFLOW_RUN_ID: "run-gate-test",
			CODEFLOW_RUNS_DIR: makeRunsDir(),
		};
		const handoff = inner(["handoff", "list"], env);
		expect(handoff.exitCode).toBe(0);
		const roster = inner(["roster"], env);
		expect(roster.exitCode).toBe(0);
	});
});

describe("P8: inner vocabulary routing", () => {
	function runEnv(): Record<string, string> {
		return {
			...baseEnv(),
			CODEFLOW_RUN_ID: "run-gate-test",
			CODEFLOW_RUNS_DIR: makeRunsDir(),
		};
	}

	test("bare code-agent prints usage and fails", () => {
		const result = inner([], runEnv());
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/usage/i);
	});

	test("check patch without a path fails and mentions patch", () => {
		const result = inner(["check", "patch"], runEnv());
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("patch");
	});

	test("verify patch without a path fails", () => {
		const result = inner(["verify", "patch"], runEnv());
		expect(result.exitCode).not.toBe(0);
	});
});

describe("P9: sub requires a run id", () => {
	test("codeflow sub with no run id fails", () => {
		const env = { ...baseEnv(), CODEFLOW_RUNS_DIR: makeRunsDir() };
		const result = outer(["sub"], env);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.trim()).not.toBe("");
	});
});

describe("P10: sub streams from the watermark", () => {
	test("only events newer than --since are returned", () => {
		const dir = makeRunsDir();
		const events = path.join(dir, "run-a", "events");
		fs.mkdirSync(events, { recursive: true });
		fs.writeFileSync(path.join(events, "00001--planner--run_started--STARTED.json"), "{}\n");
		fs.writeFileSync(path.join(events, "00002--planner--handoff_opened--OPENED.json"), "{}\n");

		const env = { ...baseEnv(), CODEFLOW_RUNS_DIR: dir };
		const result = outer(["sub", "run-a", "--since", "1", "--timeout", "5"], env);
		expect(result.exitCode).toBe(0);

		const body = JSON.parse(result.stdout);
		expect(body.run_id).toBe("run-a");
		expect(body.seq).toBe(2);
		expect(body.events).toHaveLength(1);
		expect(body.events[0]).toMatchObject({
			seq: 2,
			subject: "planner",
			kind: "handoff_opened",
			status: "OPENED",
		});
	});
});

describe("P10b: goals are derived joins", () => {
	test("codeflow goals reports lane handoffs without goal state", () => {
		const dir = makeRunsDir();
		const runDir = path.join(dir, "run-goal");
		const goalDir = path.join(runDir, "goals", "movement-r1");
		const handoffDir = path.join(runDir, "handoffs", "h00001-tester");
		fs.mkdirSync(goalDir, { recursive: true });
		fs.mkdirSync(handoffDir, { recursive: true });
		fs.writeFileSync(path.join(goalDir, "contract.json"), JSON.stringify({
			schema_version: 1,
			id: "movement-r1",
			goal: "Deterministic movement",
			definition_of_done: ["Business tests pass"],
				created_at: "2026-01-01T00:00:00Z",
				lanes: {
					test: { role: "tester" },
					code: { role: "coder" },
					verify: { role: "verify" },
				},
		}));
		fs.writeFileSync(path.join(handoffDir, "state.json"), JSON.stringify({
			handoff_id: "h00001-tester",
			role: "tester",
			status: "done",
			result: "PASS",
			goal_id: "movement-r1",
			lane: "test",
		}));

		const env = { ...baseEnv(), CODEFLOW_RUNS_DIR: dir };
		const result = outer(["goals", "run-goal"], env);
		expect(result.exitCode).toBe(0);
		const [goal] = JSON.parse(result.stdout);
		expect(goal.goal_id).toBe("movement-r1");
		expect(goal.join.satisfied).toBe(false);
		expect(goal.lanes.test.latest_handoff.result).toBe("PASS");
		expect(goal.lanes.code.latest_handoff).toBeNull();
		expect("status" in goal).toBe(false);
	});
});

describe("P11: ls table", () => {
	test("one JSON row per run, classified by liveness", () => {
		const { dir } = buildRunsDir();
		const env = { ...baseEnv(), CODEFLOW_RUNS_DIR: dir };
		const result = outer(["ls"], env);
		expect(result.exitCode).toBe(0);

		const rows = result.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const byId = new Map(rows.map((row) => [row.run_id, row]));

		const running = byId.get("run-running");
		expect(running?.status).toBe("running");
		// Requirements truncate at 60 chars with an ASCII ellipsis.
		expect(running?.requirement).toBe("r".repeat(60) + "...");
		expect(typeof running?.duration_seconds).toBe("number");
		expect(running?.duration_seconds).toBeGreaterThanOrEqual(0);

		const finished = byId.get("run-finished");
		expect(finished?.status).toBe("finished");
		// Fixed timestamps make this duration exact: one minute.
		expect(finished?.duration_seconds).toBe(60);

		const bare = byId.get("run-bare");
		expect(bare?.status).toBe("unknown");
	});
});

describe("P12: stop", () => {
	test("kills the runner of a live run", async () => {
		const { dir, sleeper } = buildRunsDir();
		const pid = sleeper.pid;
		const env = { ...baseEnv(), CODEFLOW_RUNS_DIR: dir };
		const result = outer(["stop", "run-running"], env);
		expect(result.exitCode).toBe(0);

		const deadline = Date.now() + 5_000;
		let dead = false;
		while (Date.now() < deadline) {
			// exitCode is set once Bun reaps the child; kill(pid, 0) throwing is
			// the OS-level proof. Either one means the sleeper is gone.
			if (sleeper.exitCode !== null || !pidAlive(pid)) {
				dead = true;
				break;
			}
			await Bun.sleep(100);
		}
		expect(dead).toBe(true);
	});

	test("refuses a run whose runner already exited", () => {
		const { dir } = buildRunsDir();
		const env = { ...baseEnv(), CODEFLOW_RUNS_DIR: dir };
		const result = outer(["stop", "run-finished"], env);
		expect(result.exitCode).not.toBe(0);
	});

	test("refuses a run that does not exist", () => {
		const env = { ...baseEnv(), CODEFLOW_RUNS_DIR: makeRunsDir() };
		const result = outer(["stop", "no-such-run"], env);
		expect(result.exitCode).not.toBe(0);
	});
});

describe("P13: exec requires a requirement", () => {
	test("codeflow exec with no args fails before spawning anything", () => {
		// The 30s spawn timeout bounds this: a failure must come from argument
		// validation, long before any child (or model) could be spawned.
		const result = outer(["exec"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/requirement/i);
	});
});

describe("P14: depth-aware liveness classification", () => {
	// A depth-1 delegation exiting is routine orchestration, not a finished
	// run. Only a depth-0 exit whose pid is a recorded runner identity
	// (runner.pid or runner.child_pid) may finish a run — anything less lets
	// `ls` declare a live orchestration dead and `stop` refuse to stop it.
	test("an exited depth-1 record does not finish a live depth-0 run", async () => {
		const { dir, sleeper } = buildRunsDir();
		const live = path.join(dir, "run-running");
		fs.mkdirSync(path.join(live, "liveness"), { recursive: true });
		fs.writeFileSync(
			path.join(live, "liveness", "31337--coder--1.json"),
			JSON.stringify({
				pid: 31337,
				role: "coder",
				depth: 1,
				status: "exited",
				exited_at: new Date().toISOString(),
			}),
		);

		const env = { ...baseEnv(), CODEFLOW_RUNS_DIR: dir };
		const result = outer(["ls"], env);
		expect(result.exitCode).toBe(0);
		const rows = result.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const byId = new Map(rows.map((row) => [row.run_id, row]));
		expect(byId.get("run-running")?.status).toBe("running");

		// Because the run is still running, stop must be allowed.
		const stopped = outer(["stop", "run-running"], env);
		expect(stopped.exitCode).toBe(0);
		expect(JSON.parse(stopped.stdout).stopped).toBe(true);

		const deadline = Date.now() + 5_000;
		let dead = false;
		while (Date.now() < deadline) {
			// A killed sleeper is a zombie until Bun reaps it, and kill(pid, 0)
			// still succeeds on a zombie — check both like P12 does.
			if (sleeper.exitCode !== null || !pidAlive(sleeper.pid)) {
				dead = true;
				break;
			}
			await Bun.sleep(100);
		}
		expect(dead).toBe(true);
	});

	test("an exited depth-0 record with an unrelated pid does not finish a live run", () => {
		// The exit record's pid matches neither runner.pid nor runner.child_pid,
		// so it is not exit evidence for this run — arbitrary exited records
		// must not classify anything.
		const dir = makeRunsDir();
		const sleeper = spawnSleeper();
		const live = path.join(dir, "run-live");
		writeRunner(live, {
			pid: sleeper.pid,
			started_at: new Date().toISOString(),
			requirement: "live run",
		});
		fs.mkdirSync(path.join(live, "liveness"), { recursive: true });
		fs.writeFileSync(
			path.join(live, "liveness", "424242--planner--0.json"),
			JSON.stringify({
				pid: 424242,
				role: "planner",
				depth: 0,
				status: "exited",
				exited_at: new Date().toISOString(),
			}),
		);

		const env = { ...baseEnv(), CODEFLOW_RUNS_DIR: dir };
		const result = outer(["ls"], env);
		expect(result.exitCode).toBe(0);
		const rows = result.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows[0]?.status).toBe("running");
	});

	test("an exited depth-0 record matching runner.child_pid finishes the run", () => {
		// The depth-0 exit record is written with the pi child's pid, not the
		// supervisor's — runner.child_pid is the identity it must match.
		const dir = makeRunsDir();
		const finished = path.join(dir, "run-child-exit");
		writeRunner(finished, {
			pid: 424243,
			child_pid: 424242,
			started_at: "2026-01-01T00:00:00Z",
			requirement: "old run",
		});
		fs.mkdirSync(path.join(finished, "liveness"), { recursive: true });
		fs.writeFileSync(
			path.join(finished, "liveness", "424242--planner--0.json"),
			JSON.stringify({
				pid: 424242,
				role: "planner",
				depth: 0,
				status: "exited",
				exited_at: "2026-01-01T00:01:00Z",
			}),
		);

		const env = { ...baseEnv(), CODEFLOW_RUNS_DIR: dir };
		const result = outer(["ls"], env);
		expect(result.exitCode).toBe(0);
		const rows = result.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows[0]?.status).toBe("finished");
		expect(rows[0]?.duration_seconds).toBe(60);
	});
});

describe("P15: exec rejects delegate-only options", () => {
	// Choosing a role, a handoff file, or a dry-run print is the planner's
	// delegation decision. Accepting them on exec lets a caller bypass the
	// planner silently, so exec must refuse and name the owner of the flag.
	const delegateOnly: string[][] = [
		["--role", "coder"],
		["--agent", "coder"],
		["--handoff-file", "/tmp/handoff.md"],
		["--print"],
	];
	for (const flags of delegateOnly) {
		test(`codeflow exec ${flags[0]} fails and names its owner`, () => {
			// CODEFLOW_PI_CLI is deliberately unset: a rejection must happen at
			// parse time, long before any pi process could be spawned.
			const env = { ...baseEnv(), CODEFLOW_RUNS_DIR: makeRunsDir() };
			const result = outer(["exec", ...flags, "some requirement"], env);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/delegate|planner/i);
			if (flags[0] !== "--print") {
				expect(result.stderr).toMatch(/role|handoff/i);
			}
			// 40s: against unfixed code --role/--agent reach the real pi spawn and
			// are only stopped by the 30s spawn timeout, which must not outrun
			// this test's own timeout.
		}, 40_000);
	}

	test("code-agent delegate keeps --role and --print", () => {
		const env = {
			...baseEnv(),
			CODEFLOW_RUN_ID: "run-gate-test",
			CODEFLOW_RUNS_DIR: makeRunsDir(),
		};
		const result = inner(["delegate", "--role", "coder", "--print", "do a thing"], env);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout).role).toBe("coder");
	});
});
