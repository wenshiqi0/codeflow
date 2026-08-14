#!/usr/bin/env bun
/**
 * Liveness monitor for one codeflow agent process.
 *
 * An extension runs *inside* the process it would report on, so it dies with
 * it: a SIGKILLed or OOM-killed agent can never file its own exit receipt.
 * This is a separate detached process, which is why it can.
 *
 * It does two things and nothing else:
 *
 * - refresh `liveness/<pid>--<role>--<depth>.json` while the monitored process
 *   lives, so `code-agent roster` has a fact source; and
 * - record the exit once it happens, publishing `runner_exited` only for depth
 *   0 — a depth-1 child's exit is already observed by its parent delegation,
 *   so publishing it would be noise the observer could mistake for a stop
 *   signal.
 *
 * Elapsed wall time is never treated as failure: this waits for an actual
 * process exit and has no timeout of its own.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runnerExited } from "./handoff";
import { DEFAULT_RUNS_DIR, nowIso, RunPaths, slug, writeJsonAtomic } from "./paths";

const DEFAULT_INTERVAL_SECONDS = 60;
const POLL_INTERVAL_MS = 2000;

/**
 * The kernel state character from a `/proc/<pid>/stat` body.
 *
 * `comm` is parenthesized and may itself contain spaces and parens, so the
 * state field is parsed after the LAST `)`.
 */
export function procState(statText: string): string | null {
	const rparen = statText.lastIndexOf(")");
	if (rparen < 0) return null;
	const tail = statText.slice(rparen + 1).trim().split(/\s+/);
	return tail[0] || null;
}

/**
 * Whether a pid is a live process.
 *
 * A zombie is dead even though `kill(pid, 0)` still succeeds for it: the
 * kernel keeps a zombie's entry until someone reaps it, and an un-reaped
 * depth-0 runner (adopted by a non-init PID 1, the normal container case)
 * would otherwise block this watchdog forever — stranding the `runner_exited`
 * stop signal and hanging the observe loop. So read procfs state first and
 * count state Z as dead.
 */
export function isAlive(pid: number): boolean {
	const statFile = `/proc/${pid}/stat`;
	if (fs.existsSync(statFile)) {
		try {
			if (procState(fs.readFileSync(statFile, "utf-8")) === "Z") return false;
		} catch {
			// Fall through to the signal probe.
		}
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface WatchdogOptions {
	pid: number;
	role: string;
	depth: number;
	runId: string;
	runsDir?: string;
	intervalSeconds?: number;
}

function heartbeatFile(paths: RunPaths, options: WatchdogOptions): string {
	return path.join(paths.liveness, `${options.pid}--${slug(options.role)}--${options.depth}.json`);
}

export function writeHeartbeat(paths: RunPaths, options: WatchdogOptions): void {
	writeJsonAtomic(heartbeatFile(paths, options), {
		schema_version: 2,
		run_id: options.runId,
		pid: options.pid,
		role: options.role,
		depth: options.depth,
		status: "alive",
		heartbeat_at: nowIso(),
	});
}

export async function watch(options: WatchdogOptions): Promise<void> {
	const paths = new RunPaths(options.runsDir ?? DEFAULT_RUNS_DIR, options.runId);
	const intervalMs = (options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1000;
	let lastBeat = 0;

	while (isAlive(options.pid)) {
		const now = Date.now();
		if (now - lastBeat >= intervalMs) {
			try {
				writeHeartbeat(paths, options);
			} catch {
				// A heartbeat that cannot be written costs a signal, not the run.
			}
			lastBeat = now;
		}
		await Bun.sleep(POLL_INTERVAL_MS);
	}

	// The exit is the whole reason this process exists; record it even if the
	// heartbeats failed.
	try {
		runnerExited(paths, options.pid, options.role, options.depth);
	} catch {
		// Nothing left to do: the monitored process is already gone.
	}
}

export async function main(argv: string[]): Promise<number> {
	let pid: number | undefined;
	let role: string | undefined;
	let depth: number | undefined;
	let runId: string | undefined = process.env.CODEFLOW_RUN_ID;
	let runsDir = process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR;
	let interval = DEFAULT_INTERVAL_SECONDS;

	for (let index = 0; index < argv.length; index++) {
		const value = argv[index + 1];
		switch (argv[index]) {
			case "--pid":
				pid = Number.parseInt(value ?? "", 10);
				index++;
				break;
			case "--role":
				role = value;
				index++;
				break;
			case "--depth":
				depth = Number.parseInt(value ?? "", 10);
				index++;
				break;
			case "--run-id":
				runId = value;
				index++;
				break;
			case "--runs-dir":
				runsDir = value ?? runsDir;
				index++;
				break;
			case "--interval":
				interval = Number.parseInt(value ?? "", 10);
				index++;
				break;
			default:
				console.error(`codeflow watchdog: error: unknown option: ${argv[index]}`);
				return 1;
		}
	}

	if (pid === undefined || !Number.isSafeInteger(pid)) {
		console.error("codeflow watchdog: error: --pid is required");
		return 1;
	}
	if (!role) {
		console.error("codeflow watchdog: error: --role is required");
		return 1;
	}
	if (depth === undefined || !Number.isSafeInteger(depth)) {
		console.error("codeflow watchdog: error: --depth is required");
		return 1;
	}
	if (!runId) {
		console.error("codeflow watchdog: error: --run-id is required");
		return 1;
	}

	await watch({ pid, role, depth, runId, runsDir, intervalSeconds: interval });
	return 0;
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
