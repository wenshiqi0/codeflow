/**
 * Shell-free command execution and receipt aggregation for verify handoffs.
 *
 * A model-written pipeline can accidentally report the status of `tail` or
 * `tee` instead of the command under test. This module executes the supplied
 * argv directly, streams both output channels to complete log files, and
 * records the child's real exit code in a validator-compatible receipt entry.
 *
 * Each command also runs under a configurable wall-time timeout (12-minute
 * default, `--timeout-ms` / CODEFLOW_EVIDENCE_TIMEOUT_MS overrides, 0 = off).
 * On timeout the whole process tree is terminated, the recorder — not the
 * agent-watchdog — records exit code 124 with failure_class RUNNER_BLOCKED
 * and error_class EXECUTION_TIMEOUT, and control returns to the calling role
 * with the record already on disk. Earlier commands' records are written
 * incrementally, so they survive a later sibling's timeout.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { finishHandoff } from "./handoff";
import { DEFAULT_RUNS_DIR, RunPaths, writeJsonAtomic } from "./paths";

const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The per-command timeout default: 12 minutes.
 *
 * It must stay strictly below the bash watchdog's 15-minute ceiling
 * (BASH_TIMEOUT_DEFAULT_MS) so the recorder — which returns control with a
 * structured record — always fires before the turn-wide abort, which would
 * kill the whole agent turn instead. A command that owns a run past both
 * bounds is a hang either way; the point of this default is that the role,
 * not the watchdog, owns the failure.
 */
export const EVIDENCE_TIMEOUT_DEFAULT_MS = 720_000;

/** Environment override for the per-command timeout; the --timeout-ms flag wins. */
export const EVIDENCE_TIMEOUT_ENV = "CODEFLOW_EVIDENCE_TIMEOUT_MS";

/** The synthetic exit code a timed-out command reports (same value as GNU timeout). */
export const EVIDENCE_TIMEOUT_EXIT_CODE = 124;

/** Closed error class recorded when a command is killed by its timeout. */
export const EVIDENCE_TIMEOUT_ERROR_CLASS = "EXECUTION_TIMEOUT";

/** SIGTERM → SIGKILL escalation window so a trapper is still terminated. */
export const TREE_KILL_TERM_GRACE_MS = 1_000;

/**
 * Final failsafe after SIGKILL: stop waiting for pipe EOF and close the
 * record anyway, so a straggler holding the stdio pipes cannot extend the
 * timeout into an unbounded wait — bounded wall time is the whole feature.
 */
export const TREE_KILL_FORCE_CLOSE_MS = 2_000;

/** Node timers above this value overflow and fire almost immediately. */
export const MAX_EVIDENCE_TIMEOUT_MS = 2_147_483_647;

export class EvidenceError extends Error {}

export interface CommandEvidenceEntry {
	id: string;
	status: "PASS" | "FAIL";
	command: string;
	command_argv: string[];
	exit_code: number;
	duration_ms: number;
	stdout_ref: string;
	stderr_ref: string;
	recorded_at: string;
	failure_class?: "RUNNER_BLOCKED";
	/** Set when failure_class is RUNNER_BLOCKED because the command exceeded its timeout. */
	error_class?: "EXECUTION_TIMEOUT";
	/** The timeout that terminated this command, when one fired. */
	timeout_ms?: number;
}

function parseTimeoutMs(raw: string, source: string): number {
	const trimmed = raw.trim();
	const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_EVIDENCE_TIMEOUT_MS) {
		throw new EvidenceError(
			`invalid ${source}: ${JSON.stringify(raw)}; the per-command timeout must be a ` +
				`non-negative integer number of milliseconds no greater than ` +
				`${MAX_EVIDENCE_TIMEOUT_MS} (0 disables it)`,
		);
	}
	return parsed;
}

/**
 * Resolve the per-command timeout: --timeout-ms beats
 * CODEFLOW_EVIDENCE_TIMEOUT_MS, which beats the 12-minute default. Invalid
 * values are rejected loudly in the safe direction — a typo'd override must
 * never degrade into an unbounded command, which is the failure mode the
 * timeout exists to close.
 */
export function resolveEvidenceTimeoutMs(
	override: string | undefined,
	env: Record<string, string | undefined> = process.env,
): number {
	if (override !== undefined) return parseTimeoutMs(override, "--timeout-ms");
	const raw = env[EVIDENCE_TIMEOUT_ENV];
	if (raw === undefined) return EVIDENCE_TIMEOUT_DEFAULT_MS;
	return parseTimeoutMs(raw, `${EVIDENCE_TIMEOUT_ENV} (per-command evidence timeout)`);
}

export interface RunCommandEvidenceOptions {
	/** Raw --timeout-ms flag value; see resolveEvidenceTimeoutMs for precedence. */
	timeoutMs?: string;
}

function currentPaths(): { paths: RunPaths; handoffId: string } {
	const runId = process.env.CODEFLOW_RUN_ID;
	const handoffId = process.env.CODEFLOW_HANDOFF_ID;
	if (!runId) throw new EvidenceError("CODEFLOW_RUN_ID is required");
	if (!handoffId) throw new EvidenceError("CODEFLOW_HANDOFF_ID is required");
	const runsDir = path.resolve(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR);
	return { paths: new RunPaths(runsDir, runId), handoffId };
}

function commandDir(paths: RunPaths, handoffId: string): string {
	return path.join(paths.evidence, handoffId, "commands");
}

/**
 * A recorder-owned timeout is a mechanical handoff transition, not a model
 * judgment. Finish the registered child immediately after its evidence is
 * durable so the delegator receives EXECUTION_TIMEOUT even if the role fails
 * to issue a final handoff command. A missing/terminal state is harmless for
 * standalone use and must not hide the command record.
 */
function finishExecutionTimeout(
	paths: RunPaths,
	handoffId: string,
	id: string,
	timeoutMs: number,
): void {
	if (!fs.existsSync(paths.statePath(handoffId))) return;
	try {
		finishHandoff(paths, {
			handoffId,
			status: "BLOCKED",
			summary: `evidence command ${id} exceeded its per-command timeout`,
			blockedReasons: [EVIDENCE_TIMEOUT_ERROR_CLASS],
			detail:
				`code-agent evidence run terminated the process tree after ${timeoutMs}ms ` +
				`and recorded exit ${EVIDENCE_TIMEOUT_EXIT_CODE}`,
		});
	} catch {
		// Terminal handoffs are immutable. Preserve the verdict already stored
		// by the role or an earlier mechanical failure path.
	}
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function renderCommand(argv: string[]): string {
	return argv.map(shellQuote).join(" ");
}

function closeStream(stream: fs.WriteStream): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.once("error", reject);
		stream.end(resolve);
	});
}

export async function runCommandEvidence(
	id: string,
	argv: string[],
	options: RunCommandEvidenceOptions = {},
): Promise<number> {
	if (!EVIDENCE_ID_PATTERN.test(id)) {
		throw new EvidenceError(
			"evidence id must be 1-64 filename-safe characters starting with a letter or digit",
		);
	}
	if (argv.length === 0) throw new EvidenceError("evidence run requires a command after --");
	// Rejected before any filesystem work: a refused run leaves no partial
	// evidence state behind.
	const timeoutMs = resolveEvidenceTimeoutMs(options.timeoutMs);

	const { paths, handoffId } = currentPaths();
	const directory = commandDir(paths, handoffId);
	fs.mkdirSync(directory, { recursive: true });
	const recordPath = path.join(directory, `${id}.json`);
	const claimPath = path.join(directory, `${id}.claim`);
	const stdoutPath = path.join(directory, `${id}.stdout.log`);
	const stderrPath = path.join(directory, `${id}.stderr.log`);
	if ([recordPath, claimPath, stdoutPath, stderrPath].some((target) => fs.existsSync(target))) {
		throw new EvidenceError(`evidence id already exists for this handoff: ${id}`);
	}
	let claim: number;
	try {
		// Reserve the id without exposing the final .json path. Readers either
		// see no record or the complete document installed by writeJsonAtomic;
		// they can never observe an empty placeholder as malformed evidence.
		claim = fs.openSync(claimPath, "wx");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new EvidenceError(`evidence id already exists for this handoff: ${id}`);
		}
		throw error;
	}
	fs.closeSync(claim);

	const stdoutLog = fs.createWriteStream(stdoutPath, { flags: "wx" });
	const stderrLog = fs.createWriteStream(stderrPath, { flags: "wx" });
	const startedAt = Date.now();
	let spawnFailed = false;
	let timedOut = false;

	const child = spawn(argv[0], argv.slice(1), {
		cwd: process.cwd(),
		env: process.env,
		shell: false,
		stdio: ["inherit", "pipe", "pipe"],
		// Own process group, so the timeout can signal the command's whole
		// tree at once: killing only the direct child leaves grandchildren
		// (shell jobs, trappers) running with the run's evidence pipes open.
		detached: process.platform !== "win32",
	});

	/** Signal the child's whole process group; fall back to the direct child. */
	function signalProcessTree(signal: NodeJS.Signals): void {
		if (child.pid === undefined) return;
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// The group is already gone, or group signals are unsupported.
		}
		try {
			child.kill(signal);
		} catch {
			// Already dead; the close handler still runs.
		}
	}

	child.stdout.on("data", (chunk: Buffer) => {
		stdoutLog.write(chunk);
		process.stdout.write(chunk);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderrLog.write(chunk);
		process.stderr.write(chunk);
	});
	child.on("error", (error) => {
		spawnFailed = true;
		const message = `command failed to start: ${error.message}\n`;
		stderrLog.write(message);
		process.stderr.write(message);
	});

	// The escalation chain, armed only when a timeout is set. SIGTERM gives
	// well-behaved trees a clean exit; a descendant that traps it is reached
	// by the SIGKILL escalation even when the direct child exits first. The
	// force-close keeps a straggler holding the pipes from stretching the
	// bound past the timeout.
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	let escalateTimer: ReturnType<typeof setTimeout> | undefined;
	let forceTimer: ReturnType<typeof setTimeout> | undefined;
	const clearKillTimers = (): void => {
		for (const timer of [timeoutTimer, escalateTimer, forceTimer]) {
			if (timer) clearTimeout(timer);
		}
		timeoutTimer = undefined;
		escalateTimer = undefined;
		forceTimer = undefined;
	};
	const exitCode = await new Promise<number>((resolve) => {
		let settled = false;
		let childClosed = false;
		let escalationComplete = false;

		const finish = (code: number): void => {
			if (settled) return;
			settled = true;
			clearKillTimers();
			resolve(code);
		};

		child.once("close", (code) => {
			childClosed = true;
			if (!timedOut) finish(spawnFailed ? 127 : (code ?? 1));
			else if (escalationComplete) finish(EVIDENCE_TIMEOUT_EXIT_CODE);
		});

		if (timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				timeoutTimer = undefined;
				timedOut = true;
				signalProcessTree("SIGTERM");
				escalateTimer = setTimeout(() => {
					escalateTimer = undefined;
					// Always signal the original process group after the grace
					// period. The direct child may already be closed while a
					// redirected descendant that ignored SIGTERM is still alive.
					signalProcessTree("SIGKILL");
					escalationComplete = true;
					if (childClosed) {
						finish(EVIDENCE_TIMEOUT_EXIT_CODE);
						return;
					}
					forceTimer = setTimeout(() => {
						forceTimer = undefined;
						child.stdout?.destroy();
						child.stderr?.destroy();
						finish(EVIDENCE_TIMEOUT_EXIT_CODE);
					}, TREE_KILL_FORCE_CLOSE_MS);
					forceTimer.unref?.();
				}, TREE_KILL_TERM_GRACE_MS);
				escalateTimer.unref?.();
			}, timeoutMs);
			timeoutTimer.unref?.();
		}
	});
	if (timedOut) {
		const message =
			`command exceeded the ${timeoutMs}ms per-command timeout; ` +
			`terminated its process tree (exit ${EVIDENCE_TIMEOUT_EXIT_CODE})\n`;
		stderrLog.write(message);
		process.stderr.write(message);
	}
	await Promise.all([closeStream(stdoutLog), closeStream(stderrLog)]);

	const relative = (target: string) => path.relative(paths.runsRoot, target);
	const entry: CommandEvidenceEntry = {
		id,
		status: exitCode === 0 ? "PASS" : "FAIL",
		command: renderCommand(argv),
		command_argv: argv,
		exit_code: exitCode,
		duration_ms: Date.now() - startedAt,
		stdout_ref: relative(stdoutPath),
		stderr_ref: relative(stderrPath),
		recorded_at: new Date().toISOString(),
		...(spawnFailed ? { failure_class: "RUNNER_BLOCKED" as const } : {}),
		...(timedOut
			? {
					failure_class: "RUNNER_BLOCKED" as const,
					error_class: EVIDENCE_TIMEOUT_ERROR_CLASS,
					timeout_ms: timeoutMs,
				}
			: {}),
	};
	writeJsonAtomic(recordPath, entry);
	fs.unlinkSync(claimPath);
	if (timedOut) finishExecutionTimeout(paths, handoffId, id, timeoutMs);
	console.error(`code-agent evidence: recorded ${id} at ${recordPath}`);
	return exitCode;
}

function loadEntries(paths: RunPaths, handoffId: string): CommandEvidenceEntry[] {
	const directory = commandDir(paths, handoffId);
	if (!fs.existsSync(directory)) {
		throw new EvidenceError("no command evidence exists for this handoff");
	}
	const entries = fs
		.readdirSync(directory)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => {
			try {
				return JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) as unknown;
			} catch {
				throw new EvidenceError(`command evidence entry is unreadable: ${name}`);
			}
		});
	if (entries.length === 0) throw new EvidenceError("no command evidence exists for this handoff");
	for (const [index, entry] of entries.entries()) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			!("status" in entry) ||
			!("command" in entry) ||
			!("exit_code" in entry) ||
			!(["PASS", "FAIL"] as unknown[]).includes(entry.status) ||
			typeof entry.command !== "string" ||
			typeof entry.exit_code !== "number" ||
			!Number.isInteger(entry.exit_code)
		) {
			throw new EvidenceError(`command evidence entry ${index} is malformed`);
		}
	}
	return entries as CommandEvidenceEntry[];
}

export function writeCommandReceipt(output: string): { output: string; status: "PASS" | "FAIL"; count: number } {
	const { paths, handoffId } = currentPaths();
	const entries = loadEntries(paths, handoffId);
	const status = entries.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL";
	const target = path.resolve(output);
	writeJsonAtomic(target, { status, receipts: entries });
	return { output: target, status, count: entries.length };
}
