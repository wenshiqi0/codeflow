/**
 * Filesystem layout for one run, and the atomic write primitive everything
 * else depends on.
 *
 * ```text
 * <runs-dir>/                      default .codeflow/runs/code
 * ├── _spool/                      run-level events, for cross-run discovery
 * └── <run-id>/
 *     ├── handoffs/<handoff-id>/   handoff.md, state.json, receipt.json, title.txt
 *     ├── goals/<goal-id>/        immutable goal contracts; no goal state machine
 *     ├── pi-sessions/              goal/lane session files
 *     ├── active/<handoff-id>      sentinel per in-flight handoff
 *     ├── events/                  the outer loop's only listening surface
 *     ├── tmp/                     staging; rename into events/ delivers
 *     ├── liveness/                watchdog heartbeats
 *     ├── facts.jsonl              this run's shared fact ledger
 *     └── runner.json              depth-0 pid and startup info
 * ```
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_RUNS_DIR = ".codeflow/runs/code";

/** Resolved filesystem facts for one run. */
export class RunPaths {
	readonly code: string;
	readonly runsRoot: string;
	readonly runId: string;
	readonly spool: string;

	constructor(runsDir: string, runId: string) {
		this.code = runsDir;
		this.runsRoot = path.dirname(runsDir);
		this.runId = runId;
		this.spool = path.join(runsDir, "_spool");
	}

	get runDir(): string {
		return path.join(this.code, this.runId);
	}
	get handoffs(): string {
		return path.join(this.runDir, "handoffs");
	}
	get goals(): string {
		return path.join(this.runDir, "goals");
	}
	get piSessions(): string {
		return path.join(this.runDir, "pi-sessions");
	}
	get active(): string {
		return path.join(this.runDir, "active");
	}
	get events(): string {
		return path.join(this.runDir, "events");
	}
	get tmp(): string {
		return path.join(this.runDir, "tmp");
	}
	get liveness(): string {
		return path.join(this.runDir, "liveness");
	}
	get evidence(): string {
		return path.join(this.runsRoot, "evidence", this.runId);
	}
	get eventSeq(): string {
		return path.join(this.runDir, ".events.seq");
	}
	get handoffSeq(): string {
		return path.join(this.runDir, ".handoffs.seq");
	}

	handoffDir(handoffId: string): string {
		return path.join(this.handoffs, handoffId);
	}
	goalDir(goalId: string): string {
		return path.join(this.goals, goalId);
	}
	goalContractPath(goalId: string): string {
		return path.join(this.goalDir(goalId), "contract.json");
	}
	statePath(handoffId: string): string {
		return path.join(this.handoffDir(handoffId), "state.json");
	}
	receiptPath(handoffId: string): string {
		return path.join(this.handoffDir(handoffId), "receipt.json");
	}
	titlePath(handoffId: string): string {
		return path.join(this.handoffDir(handoffId), "title.txt");
	}
}

/**
 * Write through a per-process staging file, then rename.
 *
 * A reader must never observe a partial document: the outer loop polls these
 * files while they are being written, and half a `state.json` parses as
 * nothing at all.
 */
export function writeJsonAtomic(target: string, value: unknown): void {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const staging = path.join(
		path.dirname(target),
		`.${path.basename(target)}.${process.pid}.tmp`,
	);
	fs.writeFileSync(staging, JSON.stringify(value, null, 2) + "\n", "utf-8");
	fs.renameSync(staging, target);
}

export function readJson<T = unknown>(file: string): T {
	return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
}

/** Lowercase, filesystem- and event-filename-safe. */
export function slug(value: unknown): string {
	const cleaned = String(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned || "unnamed";
}

export function nowIso(): string {
	return new Date().toISOString();
}
