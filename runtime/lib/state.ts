import * as fs from "node:fs";
import * as path from "node:path";
import { type GoalRecord, goalRecords, loadGoal } from "./goals";
import {
	foldReceipts,
	commitmentHistory,
	isTerminalStatus,
	type EffectReference,
	type CommitmentView,
	type ReceiptRecord,
	type ReceiptStatus,
} from "./commitment";
import { RunPaths } from "./paths";
import { loadTask, type TaskRecord } from "./tasks";

export type GoalStatus = "waiting" | "pending" | "active" | ReceiptStatus;

export interface GoalState {
	goal_id: string;
	objective: string;
	dependencies: string[];
	status: GoalStatus;
	commitment_refs: string[];
	receipt_refs: string[];
	summaries: string[];
	effects: EffectReference[];
	remaining: string[];
}

export interface TaskState {
	task_id: string;
	objective: string;
	status: GoalStatus;
	root: GoalState;
	goals: GoalState[];
}

function reduceHistory(
	goalId: string,
	objective: string,
	dependencies: string[],
	history: CommitmentView[],
	dependencyStates: Map<string, GoalStatus>,
): GoalState {
	const receipts: ReceiptRecord[] = history
		.flatMap((view) => view.folded.receipts)
		.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
	const hasOpen = history.some((view) => view.folded.terminal === null);
	const terminal = receipts.filter((receipt) => isTerminalStatus(receipt.status));
	const dependenciesComplete = dependencies.every((id) => dependencyStates.get(id) === "completed");
	let status: GoalStatus;
	if (hasOpen) status = "active";
	else if (terminal.length > 0) status = terminal.at(-1)!.status as ReceiptStatus;
	else status = dependenciesComplete ? "pending" : "waiting";
	const reports = foldReceipts(receipts);
	return {
		goal_id: goalId,
		objective,
		dependencies,
		status,
		commitment_refs: history.map((view) => view.commitment.id),
		receipt_refs: receipts.map((receipt) => receipt.id),
		summaries: reports.summaries,
		effects: reports.effects,
		remaining: reports.remaining,
	};
}

function topologicalGoals(goals: GoalRecord[]): GoalRecord[] {
	const byId = new Map(goals.map((goal) => [goal.id, goal]));
	const result: GoalRecord[] = [];
	const visited = new Set<string>();
	const visit = (goal: GoalRecord): void => {
		if (visited.has(goal.id)) return;
		for (const dependency of goal.dependencies) {
			const target = byId.get(dependency);
			if (target) visit(target);
		}
		visited.add(goal.id);
		result.push(goal);
	};
	for (const goal of goals) visit(goal);
	return result;
}

export function goalState(paths: RunPaths, goalId: string): GoalState {
	const task = loadTask(paths);
	const history = commitmentHistory(paths);
	if (goalId === task.id) {
		return reduceHistory(task.id, task.objective, [], history.filter((view) => view.commitment.goal_id === task.id), new Map());
	}
	const states = new Map<string, GoalStatus>();
	let selected: GoalState | undefined;
	for (const goal of topologicalGoals(goalRecords(paths))) {
		const state = reduceHistory(
			goal.id,
			goal.objective,
			goal.dependencies,
			history.filter((view) => view.commitment.goal_id === goal.id),
			states,
		);
		states.set(goal.id, state.status);
		if (goal.id === goalId) selected = state;
	}
	if (!selected) loadGoal(paths, goalId);
	return selected!;
}

export function taskState(paths: RunPaths): TaskState {
	const task: TaskRecord = loadTask(paths);
	const history = commitmentHistory(paths);
	const root = reduceHistory(
		task.id,
		task.objective,
		[],
		history.filter((view) => view.commitment.goal_id === task.id),
		new Map(),
	);
	const dependencyStates = new Map<string, GoalStatus>();
	const goals = topologicalGoals(goalRecords(paths)).map((goal) => {
		const state = reduceHistory(
			goal.id,
			goal.objective,
			goal.dependencies,
			history.filter((view) => view.commitment.goal_id === goal.id),
			dependencyStates,
		);
		dependencyStates.set(goal.id, state.status);
		return state;
	});
	const hasOpen = root.status === "active" || goals.some((goal) => goal.status === "active");
	const childrenClosed = goals.every((goal) => goal.status === "completed" || goal.status === "blocked");
	let status: GoalStatus = hasOpen
		? "active"
		: root.status === "completed" && !childrenClosed
			? "blocked"
			: root.status;
	// An executor Receipt, even under the root Goal, never closes an outer Task.
	const teamFile = path.join(paths.runDir, "team.json");
	if (fs.existsSync(teamFile)) {
		const team = JSON.parse(fs.readFileSync(teamFile, "utf8"));
		status = team.status === "open" ? (hasOpen ? "active" : "pending") : team.status;
	}
	return { task_id: task.id, objective: task.objective, status, root, goals };
}
