import * as fs from "node:fs";
import { canonicalJson } from "./canonical";
import { RunPaths, readJson, writeJsonAtomic } from "./paths";

export const TASK_SCHEMA_VERSION = 1;

export class TaskError extends Error {}

/** Task is the high-dimensional root Goal of its Goal Graph. */
export interface TaskRecord {
	schema_version: 1;
	id: string;
	objective: string;
	success_conditions: string[];
}

export function createTask(
	paths: RunPaths,
	objective: string,
	successConditions: string[] = [],
): TaskRecord {
	const normalizedObjective = objective.trim();
	if (!normalizedObjective) throw new TaskError("task objective must be a non-empty string");
	const task: TaskRecord = {
		schema_version: TASK_SCHEMA_VERSION,
		id: paths.runId,
		objective: normalizedObjective,
		success_conditions: [...new Set(successConditions.map((value) => value.trim()).filter(Boolean))],
	};
	if (fs.existsSync(paths.task)) {
		const existing = loadTask(paths);
		if (canonicalJson(existing) !== canonicalJson(task)) {
			throw new TaskError(`task already exists with different content: ${paths.runId}`);
		}
		return existing;
	}
	writeJsonAtomic(paths.task, task);
	return task;
}

export function loadTask(paths: RunPaths): TaskRecord {
	if (!fs.existsSync(paths.task)) throw new TaskError(`unknown task: ${paths.runId}`);
	const task = readJson<TaskRecord>(paths.task);
	if (
		task.schema_version !== TASK_SCHEMA_VERSION ||
		task.id !== paths.runId ||
		typeof task.objective !== "string" ||
		!Array.isArray(task.success_conditions)
	) {
		throw new TaskError(`malformed task: ${paths.runId}`);
	}
	return task;
}
