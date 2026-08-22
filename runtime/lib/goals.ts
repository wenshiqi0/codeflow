/**
 * Immutable goal contracts and read-only grouping statistics.
 *
 * There is deliberately no goal state machine or join gate: handoff state,
 * receipts, and artifacts remain the only authoritative execution state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type HandoffState, handoffHistory } from "./handoff";
import { RunPaths, readJson, slug, writeJsonAtomic } from "./paths";
import { deliverEvent, eventSummary } from "./events";

export const GOAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const THREAD_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const UNGROUPED_GOAL_ID = "_ungrouped";

export class GoalError extends Error {}

export interface GoalContract {
	schema_version: 1;
	id: string;
	goal: string;
	definition_of_done: string[];
	created_at: string;
}

export interface DefineGoalOptions {
	id: string;
	goal: string;
	definitionOfDone?: string[];
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort();
}

export function defineGoal(
	paths: RunPaths,
	options: DefineGoalOptions,
): { goal_id: string; contract: string; idempotent: boolean } {
	const goalId = slug(options.id);
	if (!GOAL_ID_PATTERN.test(goalId) || goalId.startsWith("_")) {
		throw new GoalError(`goal id must match ${GOAL_ID_PATTERN} and may not start with "_": ${options.id}`);
	}
	const goal = options.goal?.trim();
	if (!goal) throw new GoalError("goal must be a non-empty string");

	const contract: GoalContract = {
		schema_version: 1,
		id: goalId,
		goal,
		definition_of_done: uniqueSorted((options.definitionOfDone ?? []).map((entry) => entry.trim()).filter(Boolean)),
		created_at: new Date().toISOString(),
	};

	const file = paths.goalContractPath(goalId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (fs.existsSync(file)) {
		const existing = readJson<GoalContract>(file);
		const canonical = {
			...existing,
			created_at: contract.created_at,
		};
		if (JSON.stringify(canonical) !== JSON.stringify(contract)) {
			throw new GoalError(`goal contract already exists with different content: ${goalId}`);
		}
		return { goal_id: goalId, contract: path.relative(process.cwd(), file), idempotent: true };
	}
	writeJsonAtomic(file, contract);
	deliverEvent({
		stagingDir: paths.tmp,
		targetDir: paths.events,
		counterPath: paths.eventSeq,
		subject: goalId,
		kind: "artifact_written",
		status: "WRITTEN",
		payload: {
			ref: path.relative(process.cwd(), file),
			summary: eventSummary(`goal contract: ${goal}`),
		},
	});
	return { goal_id: goalId, contract: path.relative(process.cwd(), file), idempotent: false };
}

export function loadGoal(paths: RunPaths, goalId: string): GoalContract {
	const file = paths.goalContractPath(slug(goalId));
	if (!fs.existsSync(file)) throw new GoalError(`unknown goal: ${goalId}`);
	const contract = readJson<GoalContract>(file);
	if (contract.schema_version !== 1) throw new GoalError(`unsupported goal contract schema: ${goalId}`);
	if ("lanes" in contract) {
		throw new GoalError(
			`goal contract ${goalId} uses the retired lane schema; create a lane-free v1 contract`,
		);
	}
	if (!contract.id || !contract.goal || !Array.isArray(contract.definition_of_done) || !contract.created_at) {
		throw new GoalError(`goal contract ${goalId} is malformed`);
	}
	return contract;
}

export function goalSessionId(runId: string, goalId: string, thread: string): string {
	const resolvedGoalId = goalId === UNGROUPED_GOAL_ID ? goalId : slug(goalId);
	if (!runId || (resolvedGoalId !== UNGROUPED_GOAL_ID && !GOAL_ID_PATTERN.test(resolvedGoalId))) {
		throw new GoalError(`invalid goal session run/goal: ${runId}/${goalId}`);
	}
	if (!THREAD_PATTERN.test(thread)) {
		throw new GoalError(`invalid goal session thread: ${thread}`);
	}
	return `${runId}-${resolvedGoalId}-${thread}`;
}

export function goalContracts(paths: RunPaths): GoalContract[] {
	if (!fs.existsSync(paths.goals)) return [];
	return fs
		.readdirSync(paths.goals, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.filter((entry) => !entry.name.startsWith("_"))
		.map((entry) => loadGoal(paths, entry.name))
		.sort((left, right) => left.id.localeCompare(right.id));
}

export interface GoalThreadView {
	handoff_count: number;
	open_count: number;
	pass_count: number;
	fail_count: number;
	blocked_count: number;
}

export interface GoalView {
	goal_id: string;
	goal: string;
	definition_of_done: string[];
	handoff_count: number;
	open_count: number;
	pass_count: number;
	fail_count: number;
	blocked_count: number;
	threads: Record<string, GoalThreadView>;
}

export function goalView(paths: RunPaths, contract: GoalContract): GoalView {
	const handoffSequence = (id: string): number => {
		const parsed = Number.parseInt(id.slice(1), 10);
		return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
	};
	const states = handoffHistory(paths)
		.filter((state) => state.goal_id === contract.id)
		.sort((left, right) => handoffSequence(left.handoff_id) - handoffSequence(right.handoff_id));
	const threads: Record<string, GoalThreadView> = {};
	for (const state of states) {
		const key = state.thread ?? "_unspecified";
		const view = threads[key] ?? {
			handoff_count: 0,
			open_count: 0,
			pass_count: 0,
			fail_count: 0,
			blocked_count: 0,
		};
		view.handoff_count++;
		if (state.status === "open" || state.status === "running") view.open_count++;
		else if (state.status === "done" && state.result === "PASS") view.pass_count++;
		else if (state.status === "done") view.fail_count++;
		else view.blocked_count++;
		threads[key] = view;
	}
	const count = (predicate: (state: HandoffState) => boolean): number => states.filter(predicate).length;
	return {
		goal_id: contract.id,
		goal: contract.goal,
		definition_of_done: contract.definition_of_done,
		handoff_count: states.length,
		open_count: count((state) => state.status === "open" || state.status === "running"),
		pass_count: count((state) => state.status === "done" && state.result === "PASS"),
		fail_count: count((state) => state.status === "done" && state.result !== "PASS"),
		blocked_count: count((state) => state.status === "blocked"),
		threads,
	};
}

export function goalViews(paths: RunPaths): GoalView[] {
	return goalContracts(paths).map((contract) => goalView(paths, contract));
}
