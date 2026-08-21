/**
 * Benchmark run ids (contract §1.7–§1.8).
 *
 * `bench-<YYYYMMDD-HHMMSS>-<4 hex>` matches the existing run-id convention
 * (`runtime/cli/run.ts` `newRunId`): sortable, lowercase, filesystem- and
 * event-filename-safe, so benchmark out dirs list chronologically.
 *
 * Evaluation run ids are deterministic and unique per (benchmark run,
 * instance, attempt): the official harness caches by `run_id + instance_id`,
 * so every distinct attempt or re-run must produce a distinct id and can
 * never silently reuse an older verdict.
 */

import { randomBytes } from "node:crypto";
import { caseDirName } from "./workspace";

function stamp(now: Date): string {
	return now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

export function newBenchmarkRunId(now = new Date()): string {
	return `bench-${stamp(now)}-${randomBytes(2).toString("hex")}`;
}

/** A fresh Codeflow run id per instance execution — never shared across attempts. */
export function newAttemptRunId(now = new Date()): string {
	return `run-${stamp(now)}-${randomBytes(2).toString("hex")}`;
}

/** Format: `${benchmarkRunId}--${caseDirName(instanceId)}--a${attempt}`. */
export function newEvaluationRunId(benchmarkRunId: string, instanceId: string, attempt: number): string {
	return `${benchmarkRunId}--${caseDirName(instanceId)}--a${attempt}`;
}
