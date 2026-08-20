/**
 * Executable product contract: verification-command execution timeouts.
 *
 * SSOT for the per-command timeout of `code-agent evidence run`. The verify
 * role executes long checks through the shell-free recorder; today a command
 * that never exits owns the run until the 15-minute bash watchdog aborts the
 * whole agent turn. This contract pins the intended behavior BEFORE
 * implementation (red-first):
 *
 * 1. A command exceeding the per-command timeout has its whole process tree
 *    terminated — the direct child AND its descendants, including ones that
 *    ignore SIGTERM (only a SIGKILL escalation reaches them).
 * 2. The recorder — not the watchdog — owns the timeout. The CLI returns
 *    exit code 124 and writes a structured record atomically: status FAIL,
 *    exit_code 124, failure_class RUNNER_BLOCKED, error_class
 *    EXECUTION_TIMEOUT. The role regains control instead of the agent turn
 *    being aborted.
 * 3. The default (12 minutes = 720000ms) sits strictly below the bash
 *    watchdog's 15-minute ceiling so the recorder always fires first.
 * 4. Overrides: `--timeout-ms <ms>` beats `CODEFLOW_EVIDENCE_TIMEOUT_MS`,
 *    which beats the default. `0` disables (the repo's established escape
 *    hatch). Anything unparseable or negative is rejected loudly, never
 *    silently parsed into "no timeout" — a typo'd env var must not recreate
 *    the unbounded hang this contract exists to close.
 * 5. Completed command evidence persists incrementally: entries already
 *    recorded survive a later sibling's timeout, and the aggregated receipt
 *    stays validator-compatible.
 *
 * Runner: bun test tests/evidence/execution-timeout.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as commandEvidence from "../../runtime/lib/command-evidence";
// Cache-busting query (repo convention for this env-sensitive module):
// tests/agent-watchdog must stay the first plain-path import; only the
// constant BASH_TIMEOUT_DEFAULT_MS is read here, which is env-independent.
import * as agentWatchdog from "../../runtime/extensions/agent-watchdog/index.ts?evidence-defaults";
import { finishHandoff, openHandoff } from "../../runtime/lib/handoff";
import { RunPaths } from "../../runtime/lib/paths";

const REPO = path.resolve(import.meta.dir, "../..");
const CODE_AGENT = path.join(REPO, "runtime", "bin", "code-agent");
const RUN_ID = "run-evidence-timeout-test";
const HANDOFF_ID = "h00002-verify";

/** 12 minutes: the contract default for one verification command. */
const DEFAULT_TIMEOUT_MS = 720_000;

let project: string;
let paths: RunPaths;
let env: Record<string, string>;

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-evidence-timeout-"));
	Bun.spawnSync(["git", "init", "-q"], { cwd: project });
	paths = new RunPaths(path.join(project, ".state", "code"), RUN_ID);
	env = Object.fromEntries(
		Object.entries({
			...process.env,
			CODEFLOW_RUN_ID: RUN_ID,
			CODEFLOW_HANDOFF_ID: HANDOFF_ID,
			CODEFLOW_RUNS_DIR: paths.code,
		}).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	delete env.CODEFLOW_EVIDENCE_TIMEOUT_MS;
});

afterEach(() => {
	fs.rmSync(project, { recursive: true, force: true });
});

interface EvidenceRun {
	exitCode: number | null;
	stderr: string;
	elapsedMs: number;
}

function evidence(args: string[], timeoutMs = 12_000): EvidenceRun {
	const startedAt = Date.now();
	const result = Bun.spawnSync(["bash", CODE_AGENT, "evidence", ...args], {
		cwd: project,
		env,
		timeout: timeoutMs,
	});
	return {
		exitCode: result.exitCode,
		stderr: result.stderr.toString(),
		elapsedMs: Date.now() - startedAt,
	};
}

function commandDir(): string {
	return path.join(paths.evidence, HANDOFF_ID, "commands");
}

function record(id: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(commandDir(), `${id}.json`), "utf8"));
}

function isDead(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/** Poll for process death: a SIGKILLed tree may take a moment to be reaped. */
async function waitUntilDead(pid: number, budgetMs = 5_000): Promise<boolean> {
	for (let waited = 0; waited < budgetMs; waited += 50) {
		if (isDead(pid)) return true;
		await Bun.sleep(50);
	}
	return isDead(pid);
}

/** Best-effort cleanup of deliberately stubborn leftovers in the red state. */
function killIfAlive(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

describe("verification-command execution timeout contract", () => {
	test("the default per-command timeout is 12 minutes, strictly below the 15-minute bash watchdog", () => {
		// The recorder must fire before the agent-watchdog's bash ceiling
		// (BASH_TIMEOUT_DEFAULT_MS, 900000). If the default were >= the
		// watchdog's, the whole agent turn would still be aborted first and
		// the role would never regain control — the exact failure mode this
		// feature exists to remove. Assert against the watchdog's own
		// constant, not a literal, so the two defaults cannot drift apart
		// without this test noticing.
		const defaultMs = (commandEvidence as { EVIDENCE_TIMEOUT_DEFAULT_MS?: number })
			.EVIDENCE_TIMEOUT_DEFAULT_MS;
		const bashCeiling = (agentWatchdog as { BASH_TIMEOUT_DEFAULT_MS?: number })
			.BASH_TIMEOUT_DEFAULT_MS;
		expect(bashCeiling).toBe(900_000);
		expect(defaultMs).toBe(DEFAULT_TIMEOUT_MS);
		expect(defaultMs).toBeLessThan(bashCeiling!);
	});

	test("an explicit --timeout-ms terminates the command, records structured evidence, and returns control (exit 124)", () => {
		const run = evidence([
			"run",
			"--id",
			"hang",
			"--timeout-ms",
			"800",
			"--",
			"bash",
			"-c",
			"printf 'output before the hang'; sleep 30",
		]);

		// The recorder owns the failure: the CLI comes back promptly with the
		// timeout exit code instead of hanging or aborting the agent.
		expect(run.exitCode).toBe(124);
		expect(run.elapsedMs).toBeLessThan(10_000);

		// Structured, atomic record: one complete JSON document with the
		// closed classification triple and the real (synthetic) exit code.
		expect(record("hang")).toMatchObject({
			id: "hang",
			status: "FAIL",
			exit_code: 124,
			failure_class: "RUNNER_BLOCKED",
			error_class: "EXECUTION_TIMEOUT",
		});
		const entry = record("hang") as { duration_ms?: number };
		expect(typeof entry.duration_ms).toBe("number");
		expect(entry.duration_ms!).toBeGreaterThanOrEqual(700);

		// Output streamed before the kill is preserved in the complete logs.
		expect(fs.readFileSync(path.join(commandDir(), "hang.stdout.log"), "utf8")).toBe(
			"output before the hang",
		);
		expect(fs.existsSync(path.join(commandDir(), "hang.stderr.log"))).toBe(true);

		// Atomicity discipline: the commands directory holds exactly the
		// claim-replaced record and its two logs — no staging leftovers a
		// polling reader could mistake for evidence.
		expect(fs.readdirSync(commandDir()).sort()).toEqual([
			"hang.json",
			"hang.stderr.log",
			"hang.stdout.log",
		]);
	});

	test("a registered timed-out child is mechanically BLOCKED for planner intervention", () => {
		openHandoff(paths, { role: "planner", depth: 0, body: "Goal: own timeout recovery\n" });
		const verify = openHandoff(paths, {
			role: "verify",
			depth: 1,
			body: "Goal: run the bounded check\n",
		});
		expect(verify.handoff_id).toBe(HANDOFF_ID);

		expect(
			evidence([
				"run",
				"--id",
				"planner-transfer",
				"--timeout-ms",
				"300",
				"--",
				"bash",
				"-c",
				"sleep 10",
			]).exitCode,
		).toBe(124);

		const state = JSON.parse(fs.readFileSync(paths.statePath(HANDOFF_ID), "utf8")) as {
			status?: string;
			blocked?: { reasons?: string[] };
		};
		expect(state.status).toBe("blocked");
		expect(state.blocked?.reasons).toEqual(["EXECUTION_TIMEOUT"]);
		expect(record("planner-transfer")).toMatchObject({
			exit_code: 124,
			failure_class: "RUNNER_BLOCKED",
			error_class: "EXECUTION_TIMEOUT",
		});
	});

	test("CODEFLOW_EVIDENCE_TIMEOUT_MS overrides the default; --timeout-ms overrides the env", () => {
		// Env alone. The inner sleep outlives the 800ms timeout but not the
		// outer spawn bound, so a missing implementation cannot leak orphans.
		env.CODEFLOW_EVIDENCE_TIMEOUT_MS = "800";
		const envRun = evidence([
			"run",
			"--id",
			"env-hang",
			"--",
			"bash",
			"-c",
			"sleep 8",
		], 12_000);
		expect(envRun.exitCode).toBe(124);
		expect((record("env-hang") as { error_class?: string }).error_class).toBe(
			"EXECUTION_TIMEOUT",
		);

		// Flag wins over env: 60s env vs 800ms flag against an 8s sleep —
		// if the env won, the outer spawn timeout would kill the run before
		// any evidence existed.
		env.CODEFLOW_EVIDENCE_TIMEOUT_MS = "60000";
		const flagRun = evidence([
			"run",
			"--id",
			"flag-hang",
			"--timeout-ms",
			"800",
			"--",
			"bash",
			"-c",
			"sleep 8",
		]);
		expect(flagRun.exitCode).toBe(124);
		expect(flagRun.elapsedMs).toBeLessThan(10_000);
		expect((record("flag-hang") as { error_class?: string }).error_class).toBe(
			"EXECUTION_TIMEOUT",
		);
	});

	test("a timeout kills the whole process tree, including a descendant that ignores SIGTERM", async () => {
		const pidDir = path.join(project, "pids");
		fs.mkdirSync(pidDir);
		const parentPidFile = path.join(pidDir, "parent.pid");
		const grandPidFile = path.join(pidDir, "grand.pid");
		// The grandchild traps SIGTERM: only a SIGKILL escalation to the
		// process group terminates it. Killing just the direct child, or
		// only SIGTERMing the group, leaves it alive and fails this test.
		const script =
			`echo $$ > '${parentPidFile}'; ` +
			`(trap '' TERM; sleep 60) & echo $! > '${grandPidFile}'; wait`;
		try {
			const run = evidence(
				["run", "--id", "tree", "--timeout-ms", "800", "--", "bash", "-c", script],
				20_000,
			);
			expect(run.exitCode).toBe(124);

			const parentPid = Number.parseInt(fs.readFileSync(parentPidFile, "utf8").trim(), 10);
			const grandPid = Number.parseInt(fs.readFileSync(grandPidFile, "utf8").trim(), 10);
			expect(Number.isSafeInteger(parentPid)).toBe(true);
			expect(Number.isSafeInteger(grandPid)).toBe(true);
			expect(await waitUntilDead(parentPid)).toBe(true);
			expect(await waitUntilDead(grandPid)).toBe(true);
			expect((record("tree") as { error_class?: string }).error_class).toBe(
				"EXECUTION_TIMEOUT",
			);
		} finally {
			for (const file of [parentPidFile, grandPidFile]) {
				if (!fs.existsSync(file)) continue;
				const pid = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
				if (Number.isSafeInteger(pid)) killIfAlive(pid);
			}
		}
	});

	test("--timeout-ms 0 disables the guard; the command runs to completion", () => {
		const run = evidence([
			"run",
			"--id",
			"unbounded",
			"--timeout-ms",
			"0",
			"--",
			"bash",
			"-c",
			"sleep 1; printf done",
		]);
		expect(run.exitCode).toBe(0);
		const entry = record("unbounded");
		expect(entry).toMatchObject({ status: "PASS", exit_code: 0 });
		expect("failure_class" in entry).toBe(false);
		expect("error_class" in entry).toBe(false);
	});

	test("invalid timeout values are rejected loudly and write no evidence", () => {
		for (const bad of ["-5", "abc", "1.5"]) {
			expect(
				evidence(["run", "--id", `bad-${bad.replace(/[^a-z0-9]/gi, "x")}`, "--timeout-ms", bad, "--", "true"]).exitCode,
			).toBe(1);
		}
		// A garbage env default must not be silently parsed into an unbounded
		// command — the loud rejection is the safe direction.
		env.CODEFLOW_EVIDENCE_TIMEOUT_MS = "banana";
		expect(evidence(["run", "--id", "bad-env", "--", "true"]).exitCode).toBe(1);
		expect(evidence(["run", "--id", "bad-env-2", "--", "true"]).stderr).toContain("timeout");
		// Nothing was recorded: no partial evidence state from a rejected run.
		const dir = commandDir();
		const records = fs.existsSync(dir)
			? fs.readdirSync(dir).filter((name) => name.endsWith(".json"))
			: [];
		expect(records).toEqual([]);
	});

	test("completed evidence survives a later sibling timeout and still aggregates", () => {
		openHandoff(paths, { role: "planner", depth: 0, body: "Goal: verify evidence\n" });
		const verify = openHandoff(paths, {
			role: "verify",
			depth: 1,
			body: "Goal: run checks\n",
		});
		expect(verify.handoff_id).toBe(HANDOFF_ID);

		// Earlier command completes normally.
		expect(evidence(["run", "--id", "early-ok", "--", "bash", "-c", "printf ok"]).exitCode).toBe(0);
		// Later sibling hangs and is terminated by the per-command timeout.
		// The 8s sleep outlives the 800ms timeout but not the outer bound, so
		// no implementation state can leak an orphan past the test.
		expect(
			evidence(["run", "--id", "late-hang", "--timeout-ms", "800", "--", "bash", "-c", "sleep 8"])
				.exitCode,
		).toBe(124);

		// Both entries persist; the early PASS is intact with its real exit
		// code and complete logs.
		const early = record("early-ok");
		expect(early).toMatchObject({ status: "PASS", exit_code: 0 });
		expect(fs.readFileSync(path.join(commandDir(), "early-ok.stdout.log"), "utf8")).toBe("ok");
		expect(record("late-hang")).toMatchObject({
			status: "FAIL",
			exit_code: 124,
			error_class: "EXECUTION_TIMEOUT",
		});

		// The aggregate stays validator-compatible: FAIL (not silent PASS).
		// The recorder has already made the handoff terminal BLOCKED so the
		// child cannot overwrite the timeout with a later FAIL/PASS finish.
		const output = path.join(project, "verify-receipt.json");
		const receipt = evidence(["receipt", "--output", output]);
		expect(receipt.exitCode).toBe(0);
		expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({
			status: "FAIL",
			receipts: [
				{ id: "early-ok", status: "PASS", exit_code: 0 },
				{ id: "late-hang", status: "FAIL", exit_code: 124, error_class: "EXECUTION_TIMEOUT" },
			],
		});
		expect(() =>
			finishHandoff(paths, {
				handoffId: verify.handoff_id,
				status: "FAIL",
				summary: "one check timed out",
				receipt: output,
			}),
		).toThrow();
		const state = JSON.parse(fs.readFileSync(paths.statePath(verify.handoff_id), "utf8")) as {
			status?: string;
			blocked?: { reasons?: string[] };
		};
		expect(state.status).toBe("blocked");
		expect(state.blocked?.reasons).toEqual(["EXECUTION_TIMEOUT"]);
	});

	test("the verification capability doc is the SSOT for the timeout surface", () => {
		// The role-facing doc must teach the flag, the new error class, and
		// the ownership rule: after an execution timeout the role finishes
		// BLOCKED and never silently retries — only the planner decides
		// whether to split the command, change timeout/environment, or
		// redelegate.
		const doc = fs.readFileSync(path.join(REPO, "references", "capabilities", "verification.md"), "utf8");
		expect(doc).toContain("--timeout-ms");
		expect(doc).toContain("EXECUTION_TIMEOUT");
		expect(doc).toContain("error_class");
		expect(doc).toMatch(/never implicitly retry|do not retry/);
		expect(doc).toContain("planner");

		const planner = fs.readFileSync(
			path.join(REPO, "references", "capabilities", "planning.md"),
			"utf8",
		);
		expect(planner).toContain("`EXECUTION_TIMEOUT`");
		expect(planner).toMatch(/split the command/);
		expect(planner).toMatch(/Never replay the identical timed-out command/);

		const skill = fs.readFileSync(path.join(REPO, "SKILL.md"), "utf8");
		expect(skill).toMatch(/EXECUTION_TIMEOUT.*root planner/);
		expect(skill).toMatch(/keep subscribing/);
	});
});
