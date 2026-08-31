/** Runtime-only Worker execution feedback before a Work Commitment is claimed. */

import * as fs from "node:fs";
import * as path from "node:path";
import { deliverEvent, eventSummary } from "./events";
import type { RuntimeFailureReason } from "./commitment";
import { readJson, RunPaths, writeJsonAtomic } from "./paths";

export const WORKER_REPORT_SCHEMA_VERSION = 1;

export interface WorkerReport {
	schema_version: 1;
	task_id: string;
	goal_id: string;
	execution_id: string;
	summary: string;
	remaining: string[];
}

function nonEmpty(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${field} must be a non-empty string`);
	return normalized;
}

export function writeWorkerReport(
	paths: RunPaths,
	input: Omit<WorkerReport, "schema_version" | "task_id">,
): WorkerReport {
	const file = paths.executionReportPath(input.execution_id);
	if (fs.existsSync(file)) throw new Error(`execution already reported: ${input.execution_id}`);
	const report: WorkerReport = {
		schema_version: WORKER_REPORT_SCHEMA_VERSION,
		task_id: paths.runId,
		goal_id: nonEmpty(input.goal_id, "goal_id"),
		execution_id: nonEmpty(input.execution_id, "execution_id"),
		summary: nonEmpty(input.summary, "summary"),
		remaining: input.remaining.map((value, index) => nonEmpty(value, `remaining[${index}]`)),
	};
	writeJsonAtomic(file, report);
	deliverEvent({
		stagingDir: paths.tmp,
		targetDir: paths.events,
		counterPath: paths.eventSeq,
		subject: report.execution_id,
		kind: "worker_reported",
		status: "REPORTED",
		payload: {
			task_id: paths.runId,
			goal_id: report.goal_id,
			execution_id: report.execution_id,
			ref: path.relative(paths.runDir, file),
			summary: eventSummary(report.summary),
		},
	});
	return report;
}

export function loadWorkerReport(paths: RunPaths, executionId: string): WorkerReport | null {
	const file = paths.executionReportPath(executionId);
	if (!fs.existsSync(file)) return null;
	const report = readJson<WorkerReport>(file);
	if (
		report.schema_version !== WORKER_REPORT_SCHEMA_VERSION
		|| report.task_id !== paths.runId
		|| report.execution_id !== executionId
		|| !Array.isArray(report.remaining)
	) throw new Error(`malformed worker report: ${executionId}`);
	return report;
}

export function recordExecutionFailure(
	paths: RunPaths,
	executionId: string,
	goalId: string,
	reasons: RuntimeFailureReason[],
	summary: string,
): void {
	deliverEvent({
		stagingDir: paths.tmp,
		targetDir: paths.events,
		counterPath: paths.eventSeq,
		subject: executionId,
		kind: "execution_interrupted",
		status: "INTERRUPTED",
		payload: {
			task_id: paths.runId,
			goal_id: goalId,
			execution_id: executionId,
			reasons,
			summary: eventSummary(summary),
		},
	});
}
