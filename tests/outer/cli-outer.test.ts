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
		for (const word of ["exec", "ls", "sub", "stop", "memo", "audit"]) {
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

describe("P5: memo and audit exist but refuse", () => {
	test("memo is declared, not implemented", () => {
		const result = outer(["memo", "run-x", "hello"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/not implement/i);
	});

	test("audit is declared, not implemented", () => {
		const result = outer(["audit", "run-x"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/not implement/i);
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
