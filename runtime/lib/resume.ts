/** Resolve one fully stopped run into the input for another execution attempt. */

import * as fs from "node:fs";
import * as path from "node:path";
import { RunPaths, readJson } from "./paths";
import { scan } from "./wait";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

interface RunnerMetadata {
	run_id?: string;
	requirement?: string;
}

export interface ResumeSource {
	runId: string;
	requirement: string;
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
		"runner_exited",
	]).events;
	const startIndex = lifecycle.findLastIndex(
		(event) => event.kind === "run_started" || event.kind === "run_resumed",
	);
	const finishIndex = lifecycle.findLastIndex((event) => event.kind === "run_finished");
	const exitIndex = lifecycle.findLastIndex((event) => event.kind === "runner_exited");
	if (startIndex < 0 || finishIndex < startIndex || exitIndex < finishIndex) {
		throw new ResumeError(
			`run is not fully stopped: ${paths.runId} (latest attempt requires run_finished then runner_exited)`,
		);
	}
	return { startSeq: lifecycle[startIndex].seq };
}

/**
 * Resume preserves the run identity but never reopens terminal handoffs.
 *
 * The latest execution attempt must have both its business terminal event and
 * runner exit after its most recent start/resume event. This prevents two
 * depth-0 planners from sharing one run while the earlier process is draining.
 */
export function loadResumeSource(runsDir: string, runId: string): ResumeSource {
	if (!RUN_ID_PATTERN.test(runId)) throw new ResumeError(`invalid run id: ${runId}`);
	const paths = new RunPaths(runsDir, runId);
	if (!fs.existsSync(paths.runDir)) throw new ResumeError(`no such run: ${runId}`);

	let runner: RunnerMetadata;
	try {
		runner = readJson<RunnerMetadata>(path.join(paths.runDir, "runner.json"));
	} catch {
		throw new ResumeError(`run has no readable runner metadata: ${runId}`);
	}
	if (runner.run_id !== undefined && runner.run_id !== runId) {
		throw new ResumeError(`runner metadata does not belong to run: ${runId}`);
	}
	if (typeof runner.requirement !== "string" || runner.requirement.trim() === "") {
		throw new ResumeError(`run has no resumable requirement: ${runId}`);
	}

	assertResumeStopped(paths);

	return { runId, requirement: runner.requirement };
}
