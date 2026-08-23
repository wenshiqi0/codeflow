import { type GoalRecord, goalRecords, loadGoal } from "./goals";
import { handoffHistory, type HandoffView, type ReceiptStatus } from "./handoff";
import { RunPaths } from "./paths";
import { loadTask, type TaskRecord } from "./tasks";

export type GoalStatus = "waiting" | "pending" | "active" | ReceiptStatus;

export interface GoalState {
	goal_id: string;
	objective: string;
	dependencies: string[];
	status: GoalStatus;
	runnable: boolean;
	handoff_refs: string[];
	receipt_refs: string[];
	established: string[];
	decisions: string[];
	discovered: string[];
	unresolved: string[];
	blockers: string[];
}

export interface TaskState {
	task_id: string;
	objective: string;
	status: GoalStatus;
	root: GoalState;
	goals: GoalState[];
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function reduceHistory(
	goalId: string,
	objective: string,
	dependencies: string[],
	history: HandoffView[],
	dependencyStates: Map<string, GoalStatus>,
): GoalState {
	const receipts = history
		.flatMap((view) => view.receipt ? [view.receipt] : [])
		.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
	const hasOpen = history.some((view) => view.receipt === null);
	const dependenciesComplete = dependencies.every((id) => dependencyStates.get(id) === "completed");
	let status: GoalStatus;
	if (hasOpen) status = "active";
	else if (receipts.length > 0) status = receipts.at(-1)!.status;
	else status = dependenciesComplete ? "pending" : "waiting";
	return {
		goal_id: goalId,
		objective,
		dependencies,
		status,
		runnable: dependenciesComplete && !hasOpen && status !== "completed" && status !== "superseded",
		handoff_refs: history.map((view) => view.handoff.id),
		receipt_refs: receipts.map((receipt) => receipt.id),
		established: unique(receipts.flatMap((receipt) => receipt.established)),
		decisions: unique(receipts.flatMap((receipt) => receipt.decisions)),
		discovered: unique(receipts.flatMap((receipt) => receipt.discovered)),
		unresolved: unique(receipts.flatMap((receipt) => receipt.unresolved)),
		blockers: unique(receipts.flatMap((receipt) => receipt.blockers)),
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
	const history = handoffHistory(paths);
	if (goalId === task.id) {
		return reduceHistory(task.id, task.objective, [], history.filter((view) => view.handoff.goal_id === task.id), new Map());
	}
	const states = new Map<string, GoalStatus>();
	let selected: GoalState | undefined;
	for (const goal of topologicalGoals(goalRecords(paths))) {
		const state = reduceHistory(
			goal.id,
			goal.objective,
			goal.dependencies,
			history.filter((view) => view.handoff.goal_id === goal.id),
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
	const history = handoffHistory(paths);
	const root = reduceHistory(
		task.id,
		task.objective,
		[],
		history.filter((view) => view.handoff.goal_id === task.id),
		new Map(),
	);
	const dependencyStates = new Map<string, GoalStatus>();
	const goals = topologicalGoals(goalRecords(paths)).map((goal) => {
		const state = reduceHistory(
			goal.id,
			goal.objective,
			goal.dependencies,
			history.filter((view) => view.handoff.goal_id === goal.id),
			dependencyStates,
		);
		dependencyStates.set(goal.id, state.status);
		return state;
	});
	const hasOpen = root.status === "active" || goals.some((goal) => goal.status === "active");
	const childrenClosed = goals.every((goal) => goal.status === "completed" || goal.status === "superseded");
	const status: GoalStatus = hasOpen
		? "active"
		: root.status === "completed" && !childrenClosed
			? "partial"
			: root.status;
	return { task_id: task.id, objective: task.objective, status, root, goals };
}
