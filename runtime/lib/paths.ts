/**
 * Filesystem layout for one run, and the atomic write primitive everything
 * else depends on.
 *
 * ```text
 * <runs-dir>/                      default .codeflow/runs/code
 * ├── _spool/                      run-level events, for cross-run discovery
 * └── <run-id>/
 *     ├── task.json                 stable external intent; also the graph root Goal
 *     ├── commitments/<commitment-id>/ immutable commitment.json plus an
 *     │                               append-only receipts/ chain
 *     ├── goals/<goal-id>/          child Goal contracts
 *     ├── active/<commitment-id>    sentinel per in-flight commitment
 *     ├── executions/<execution-id>/ runtime-only Worker feedback
 *     ├── events/                  the outer loop's only listening surface
 *     ├── tmp/                     staging; rename into events/ delivers
 *     ├── liveness/                watchdog heartbeats
 *     ├── .resume-claims/          one atomic claim per resumed attempt
 *     ├── usage.jsonl              one row per attributed model call
 *     ├── usage.json               aggregate report written at run exit
 *     └── runner.json              root Worker pid and startup info
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
	get commitments(): string {
		return path.join(this.runDir, "commitments");
	}
	get goals(): string {
		return path.join(this.runDir, "goals");
	}
	get executions(): string {
		return path.join(this.runDir, "executions");
	}
	get task(): string {
		return path.join(this.runDir, "task.json");
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
	get usageLedger(): string {
		return path.join(this.runDir, "usage.jsonl");
	}
	get usageSummary(): string {
		return path.join(this.runDir, "usage.json");
	}
	get runFactsLedger(): string {
		return path.join(this.runDir, "run-observations.jsonl");
	}
	get eventSeq(): string {
		return path.join(this.runDir, ".events.seq");
	}
	get semanticSeq(): string {
		return path.join(this.runDir, ".semantic.seq");
	}
	get goalSeq(): string {
		return path.join(this.runDir, ".goals.seq");
	}
	get claimLocks(): string {
		return path.join(this.runDir, ".claim-locks");
	}

	commitmentDir(commitmentId: string): string {
		return path.join(this.commitments, commitmentId);
	}
	goalDir(goalId: string): string {
		return path.join(this.goals, goalId);
	}
	goalPath(goalId: string): string {
		return path.join(this.goalDir(goalId), "goal.json");
	}
	commitmentPath(commitmentId: string): string {
		return path.join(this.commitmentDir(commitmentId), "commitment.json");
	}
	receiptDir(commitmentId: string): string {
		return path.join(this.commitmentDir(commitmentId), "receipts");
	}
	/** One immutable Receipt in the append-only chain of a Commitment. */
	receiptChainPath(commitmentId: string, seq: number, receiptId: string): string {
		return path.join(this.receiptDir(commitmentId), `${String(seq).padStart(5, "0")}--${receiptId}.json`);
	}
	claimLockPath(goalId: string): string {
		return path.join(this.claimLocks, `${slug(goalId)}.lock`);
	}
	executionReportPath(executionId: string): string {
		return path.join(this.executions, slug(executionId), "report.json");
	}
}

/**
 * Write through a per-process staging file, then rename.
 *
 * A reader must never observe a partial document: the outer loop polls these
 * files while they are being written, and half a semantic record parses as
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
