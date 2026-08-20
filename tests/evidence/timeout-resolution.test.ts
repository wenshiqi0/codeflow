/**
 * Developer unit tests for the per-command evidence timeout.
 *
 * The business contract (tests/evidence/execution-timeout.test.ts) pins the
 * end-to-end behavior through the CLI. These unit tests give fast, in-process
 * feedback on the pieces that are easy to regress silently:
 *
 * - resolveEvidenceTimeoutMs precedence (flag > env > default) and loud
 *   rejection of unparseable values;
 * - runCommandEvidence's timeout path in-process: synthetic exit code 124,
 *   closed classification triple, preserved output, and the SIGTERM->SIGKILL
 *   escalation reaching a descendant that ignores SIGTERM.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	EVIDENCE_TIMEOUT_DEFAULT_MS,
	EVIDENCE_TIMEOUT_ENV,
	EVIDENCE_TIMEOUT_EXIT_CODE,
	EvidenceError,
	MAX_EVIDENCE_TIMEOUT_MS,
	resolveEvidenceTimeoutMs,
	runCommandEvidence,
} from "../../runtime/lib/command-evidence";
import { RunPaths } from "../../runtime/lib/paths";

const RUN_ID = "run-evidence-timeout-unit";
const HANDOFF_ID = "h00002-verify";

let project: string;
let paths: RunPaths;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-evidence-timeout-unit-"));
	paths = new RunPaths(path.join(project, ".state", "code"), RUN_ID);
	for (const key of ["CODEFLOW_RUN_ID", "CODEFLOW_HANDOFF_ID", "CODEFLOW_RUNS_DIR", EVIDENCE_TIMEOUT_ENV]) {
		savedEnv[key] = process.env[key];
	}
	process.env.CODEFLOW_RUN_ID = RUN_ID;
	process.env.CODEFLOW_HANDOFF_ID = HANDOFF_ID;
	process.env.CODEFLOW_RUNS_DIR = paths.code;
	delete process.env[EVIDENCE_TIMEOUT_ENV];
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	fs.rmSync(project, { recursive: true, force: true });
});

function commandDir(): string {
	return path.join(paths.evidence, HANDOFF_ID, "commands");
}

function record(id: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(commandDir(), `${id}.json`), "utf8"));
}

describe("resolveEvidenceTimeoutMs", () => {
	test("defaults to 12 minutes when nothing overrides it", () => {
		expect(resolveEvidenceTimeoutMs(undefined, {})).toBe(EVIDENCE_TIMEOUT_DEFAULT_MS);
		expect(EVIDENCE_TIMEOUT_DEFAULT_MS).toBe(720_000);
	});

	test("the env var overrides the default; the flag overrides the env", () => {
		expect(resolveEvidenceTimeoutMs(undefined, { [EVIDENCE_TIMEOUT_ENV]: "5000" })).toBe(5000);
		expect(resolveEvidenceTimeoutMs("250", { [EVIDENCE_TIMEOUT_ENV]: "5000" })).toBe(250);
	});

	test("0 disables the guard from either source", () => {
		expect(resolveEvidenceTimeoutMs("0", { [EVIDENCE_TIMEOUT_ENV]: "5000" })).toBe(0);
		expect(resolveEvidenceTimeoutMs(undefined, { [EVIDENCE_TIMEOUT_ENV]: "0" })).toBe(0);
	});

	test("unparseable or negative values are rejected loudly, never parsed into unbounded", () => {
		for (const bad of ["-5", "abc", "1.5", "", String(MAX_EVIDENCE_TIMEOUT_MS + 1), "9".repeat(400)]) {
			for (const source of [
				{ override: bad as string, env: {} },
				{ override: undefined, env: { [EVIDENCE_TIMEOUT_ENV]: bad } },
			]) {
				let message = "";
				try {
					resolveEvidenceTimeoutMs(source.override, source.env);
				} catch (error) {
					expect(error).toBeInstanceOf(EvidenceError);
					message = (error as Error).message;
				}
				// The safe direction: a typo'd override must fail the run, not
				// degrade into "no timeout".
				expect(message).toContain("timeout");
				expect(message).toContain(JSON.stringify(bad));
			}
		}
	});
});

describe("runCommandEvidence timeout behavior (in-process)", () => {
	test("the final JSON record is invisible until it is complete", async () => {
		const running = runCommandEvidence("atomic", ["bash", "-c", "sleep 0.5"], {
			timeoutMs: "0",
		});
		await Bun.sleep(50);
		expect(fs.existsSync(path.join(commandDir(), "atomic.claim"))).toBe(true);
		expect(fs.existsSync(path.join(commandDir(), "atomic.json"))).toBe(false);

		expect(await running).toBe(0);
		expect(fs.existsSync(path.join(commandDir(), "atomic.claim"))).toBe(false);
		expect(() => record("atomic")).not.toThrow();
	}, 10_000);

	test("a timed-out command returns 124 and records the closed classification triple", async () => {
		const startedAt = Date.now();
		const exitCode = await runCommandEvidence(
			"hang",
			["bash", "-c", "printf 'partial output'; sleep 5"],
			{ timeoutMs: "300" },
		);
		expect(exitCode).toBe(EVIDENCE_TIMEOUT_EXIT_CODE);
		expect(exitCode).toBe(124);
		// Bounded wall time: the recorder returns long before the 5s sleep.
		expect(Date.now() - startedAt).toBeLessThan(4_000);

		expect(record("hang")).toMatchObject({
			id: "hang",
			status: "FAIL",
			exit_code: 124,
			failure_class: "RUNNER_BLOCKED",
			error_class: "EXECUTION_TIMEOUT",
			timeout_ms: 300,
		});
		expect(fs.readFileSync(path.join(commandDir(), "hang.stdout.log"), "utf8")).toBe(
			"partial output",
		);
	}, 10_000);

	test("timeout 0 lets the command run to completion", async () => {
		const exitCode = await runCommandEvidence("unbounded", ["bash", "-c", "sleep 1"], {
			timeoutMs: "0",
		});
		expect(exitCode).toBe(0);
		expect(record("unbounded")).toMatchObject({ status: "PASS", exit_code: 0 });
		expect("failure_class" in record("unbounded")).toBe(false);
		expect("error_class" in record("unbounded")).toBe(false);
	}, 10_000);

	test("the kill escalates to a descendant that ignores SIGTERM", async () => {
		const pidDir = path.join(project, "pids");
		fs.mkdirSync(pidDir);
		const parentPidFile = path.join(pidDir, "parent.pid");
		const grandPidFile = path.join(pidDir, "grand.pid");
		const script =
			`echo $$ > '${parentPidFile}'; ` +
			`(trap '' TERM; sleep 30) & echo $! > '${grandPidFile}'; wait`;
		try {
			const exitCode = await runCommandEvidence("tree", ["bash", "-c", script], {
				timeoutMs: "300",
			});
			expect(exitCode).toBe(124);

			const isDead = (pid: number): boolean => {
				try {
					process.kill(pid, 0);
					return false;
				} catch (error) {
					return (error as NodeJS.ErrnoException).code === "ESRCH";
				}
			};
			const waitUntilDead = async (pid: number): Promise<boolean> => {
				for (let waited = 0; waited < 5_000; waited += 50) {
					if (isDead(pid)) return true;
					await Bun.sleep(50);
				}
				return isDead(pid);
			};
			const parentPid = Number.parseInt(fs.readFileSync(parentPidFile, "utf8").trim(), 10);
			const grandPid = Number.parseInt(fs.readFileSync(grandPidFile, "utf8").trim(), 10);
			expect(await waitUntilDead(parentPid)).toBe(true);
			expect(await waitUntilDead(grandPid)).toBe(true);
			expect(record("tree").error_class).toBe("EXECUTION_TIMEOUT");
		} finally {
			for (const file of [parentPidFile, grandPidFile]) {
				if (!fs.existsSync(file)) continue;
				const pid = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
				if (Number.isSafeInteger(pid)) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						// Already gone.
					}
				}
			}
		}
	}, 15_000);

	test("the SIGKILL escalation survives the direct child closing first", async () => {
		const pidDir = path.join(project, "redirected-pids");
		fs.mkdirSync(pidDir);
		const grandPidFile = path.join(pidDir, "grand.pid");
		const script =
			`(trap '' TERM; exec >/dev/null 2>&1; sleep 30) & ` +
			`echo $! > '${grandPidFile}'; wait`;
		let grandPid = 0;
		try {
			expect(
				await runCommandEvidence("redirected-tree", ["bash", "-c", script], {
					timeoutMs: "300",
				}),
			).toBe(124);
			grandPid = Number.parseInt(fs.readFileSync(grandPidFile, "utf8").trim(), 10);
			const deadline = Date.now() + 5_000;
			let dead = false;
			while (Date.now() < deadline) {
				try {
					process.kill(grandPid, 0);
					await Bun.sleep(50);
				} catch (error) {
					dead = (error as NodeJS.ErrnoException).code === "ESRCH";
					break;
				}
			}
			expect(dead).toBe(true);
		} finally {
			if (Number.isSafeInteger(grandPid) && grandPid > 0) {
				try {
					process.kill(grandPid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		}
	}, 15_000);

	test("a rejected timeout value writes no evidence", async () => {
		await expect(
			runCommandEvidence("rejected", ["true"], { timeoutMs: "banana" }),
		).rejects.toBeInstanceOf(EvidenceError);
		expect(fs.existsSync(commandDir())).toBe(false);
	});
});
