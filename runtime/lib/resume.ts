/** Resolve one fully stopped run into the input for another execution attempt. */

import * as fs from "node:fs";
import { RunPaths } from "./paths";
import { loadTask } from "./tasks";
import { scan } from "./wait";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface ResumeSource {
	taskId: string;
	objective: string;
}

export interface ResumableAttempt {
	startSeq: number;
}

export class ResumeError extends Error {}

/** Enforce the lifecycle gate and identify the attempt an atomic claim must own. */
export function assertResumeStopped(paths: RunPaths): ResumableAttempt {
	const lifecycle = scan(paths.events, 0, [
		"run_started",
		"run_resumed",
		"run_finished",
		"run_interrupted",
		"runner_exited",
	]).events;
	const startIndex = lifecycle.findLastIndex(
		(event) => event.kind === "run_started" || event.kind === "run_resumed",
	);
	const terminalIndex = lifecycle.findLastIndex(
		(event) => event.kind === "run_finished" || event.kind === "run_interrupted",
	);
	const exitIndex = lifecycle.findLastIndex((event) => event.kind === "runner_exited");
	if (startIndex < 0 || terminalIndex < startIndex || exitIndex < terminalIndex) {
		throw new ResumeError(
			`task is not fully stopped: ${paths.runId} (latest attempt requires a semantic or runtime terminal event, then runner_exited)`,
		);
	}
	return { startSeq: lifecycle[startIndex].seq };
}

/**
 * Resume preserves the run identity but never reopens terminal commitments.
 *
 * The latest execution attempt must have both its business terminal event and
 * runner exit after its most recent start/resume event. This prevents two
 * root workers from sharing one run while the earlier process is draining.
 */
export function loadResumeSource(runsDir: string, taskId: string): ResumeSource {
	if (!RUN_ID_PATTERN.test(taskId)) throw new ResumeError(`invalid task id: ${taskId}`);
	const paths = new RunPaths(runsDir, taskId);
	if (!fs.existsSync(paths.runDir)) throw new ResumeError(`no such task: ${taskId}`);
	let task;
	try { task = loadTask(paths); }
	catch { throw new ResumeError(`task has no readable task record: ${taskId}`); }
	assertResumeStopped(paths);
	return { taskId, objective: task.objective };
}
