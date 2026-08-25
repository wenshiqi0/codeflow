/** Child Goal contracts and dependency graph validation. Task is the root Goal. */

import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalJson } from "./canonical";
import { deliverEvent, eventSummary } from "./events";
import { RunPaths, readJson, slug, writeJsonAtomic } from "./paths";
import { nextSeq } from "./seq";
import { loadTask } from "./tasks";

export const GOAL_SCHEMA_VERSION = 1;
export const GOAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class GoalError extends Error {}

export interface GoalRecord {
	schema_version: 1;
	seq: number;
	id: string;
	task_id: string;
	objective: string;
	dependencies: string[];
}

export interface CreateGoalOptions {
	id: string;
	objective: string;
	dependencies?: string[];
}

export interface PreparedGoal {
	id: string;
	objective: string;
	dependencies: string[];
	existing: GoalRecord | null;
}

function normalizeGoalId(value: string): string {
	const id = slug(value);
	if (!GOAL_ID_PATTERN.test(id) || id.startsWith("_")) {
		throw new GoalError(`goal id must match ${GOAL_ID_PATTERN} and may not start with _: ${value}`);
	}
	return id;
}

function normalizeDependencies(values: string[]): string[] {
	return [...new Set(values.map(normalizeGoalId))].sort();
}

export function loadGoal(paths: RunPaths, goalId: string): GoalRecord {
	const id = normalizeGoalId(goalId);
	const file = paths.goalPath(id);
	if (!fs.existsSync(file)) throw new GoalError(`unknown goal: ${id}`);
	const goal = readJson<GoalRecord>(file);
	if (
		goal.schema_version !== GOAL_SCHEMA_VERSION ||
		goal.id !== id ||
		goal.task_id !== paths.runId ||
		!Number.isSafeInteger(goal.seq) ||
		typeof goal.objective !== "string" ||
		!Array.isArray(goal.dependencies)
	) {
		throw new GoalError(`malformed goal: ${id}`);
	}
	return goal;
}

export function goalRecords(paths: RunPaths): GoalRecord[] {
	if (!fs.existsSync(paths.goals)) return [];
	return fs
		.readdirSync(paths.goals, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => loadGoal(paths, entry.name))
		.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
}

/** Task is a valid Goal scope; every other goal must have a persisted record. */
export function assertGoalScope(paths: RunPaths, goalId: string): void {
	if (goalId === paths.runId) {
		loadTask(paths);
		return;
	}
	loadGoal(paths, goalId);
}

function assertDependenciesExist(paths: RunPaths, goalId: string, dependencies: string[]): void {
	for (const dependency of dependencies) {
		if (dependency === goalId) throw new GoalError(`goal ${goalId} cannot depend on itself`);
		loadGoal(paths, dependency);
	}
}

function assertAcyclic(paths: RunPaths, replacement?: GoalRecord): void {
	const goals = new Map(goalRecords(paths).map((goal) => [goal.id, goal]));
	if (replacement) goals.set(replacement.id, replacement);
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visited.has(id)) return;
		if (visiting.has(id)) throw new GoalError(`goal dependency cycle includes ${id}`);
		visiting.add(id);
		for (const dependency of goals.get(id)?.dependencies ?? []) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of goals.keys()) visit(id);
}

/** Validate a Goal definition without allocating a sequence or writing state. */
export function prepareGoal(
	paths: RunPaths,
	options: CreateGoalOptions,
): PreparedGoal {
	loadTask(paths);
	const id = normalizeGoalId(options.id);
	if (id === paths.runId) throw new GoalError("task id is already the root Goal");
	const objective = options.objective.trim();
	if (!objective) throw new GoalError("goal objective must be a non-empty string");
	const dependencies = normalizeDependencies(options.dependencies ?? []);
	assertDependenciesExist(paths, id, dependencies);

	const file = paths.goalPath(id);
	if (fs.existsSync(file)) {
		const existing = loadGoal(paths, id);
		const expected = { ...existing, objective, dependencies };
		if (canonicalJson(existing) !== canonicalJson(expected)) {
			throw new GoalError(`goal already exists with different content: ${id}`);
		}
		return { id, objective, dependencies, existing };
	}

	assertAcyclic(paths, {
		schema_version: GOAL_SCHEMA_VERSION,
		seq: 0,
		id,
		task_id: paths.runId,
		objective,
		dependencies,
	});
	return { id, objective, dependencies, existing: null };
}

export function createGoal(
	paths: RunPaths,
	options: CreateGoalOptions,
): { goal_id: string; ref: string; idempotent: boolean } {
	const prepared = prepareGoal(paths, options);
	const { id, objective, dependencies } = prepared;
	const file = paths.goalPath(id);
	if (prepared.existing) {
		return { goal_id: id, ref: path.relative(process.cwd(), file), idempotent: true };
	}

	const goal: GoalRecord = {
		schema_version: GOAL_SCHEMA_VERSION,
		seq: nextSeq(paths.goalSeq),
		id,
		task_id: paths.runId,
		objective,
		dependencies,
	};
	writeJsonAtomic(file, goal);
	deliverEvent({
		stagingDir: paths.tmp,
		targetDir: paths.events,
		counterPath: paths.eventSeq,
		subject: id,
		kind: "goal_created",
		status: "CREATED",
		payload: { ref: path.relative(process.cwd(), file), goal_id: id, summary: eventSummary(objective) },
	});
	return { goal_id: id, ref: path.relative(process.cwd(), file), idempotent: false };
}

export function updateGoalDependencies(
	paths: RunPaths,
	goalId: string,
	dependencies: string[],
): GoalRecord {
	const current = loadGoal(paths, goalId);
	const next: GoalRecord = { ...current, dependencies: normalizeDependencies(dependencies) };
	assertDependenciesExist(paths, current.id, next.dependencies);
	assertAcyclic(paths, next);
	writeJsonAtomic(paths.goalPath(current.id), next);
	deliverEvent({
		stagingDir: paths.tmp,
		targetDir: paths.events,
		counterPath: paths.eventSeq,
		subject: current.id,
		kind: "goal_updated",
		status: "UPDATED",
		payload: { goal_id: current.id, ref: path.relative(process.cwd(), paths.goalPath(current.id)) },
	});
	return next;
}
