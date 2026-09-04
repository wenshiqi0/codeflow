import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	claimCommitment,
	commitmentHistory,
	goalClaimRevision,
	loadReceiptChain,
	loadTerminalReceipt,
	submitReceipt,
} from "../../lib/commitment";
import { loadWorkerReport, writeWorkerReport } from "../../lib/executions";
import { createGoal } from "../../lib/goals";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";
import { inspectCommitment, inspectGoal, inspectReceipt } from "../../lib/inspection";
import { goalState } from "../../lib/state";
import { cancelWorkers, delegateWorker, hasLiveWorkers, takeWorkerUpdates } from "./worker-launcher";
import { registerWorkerFeedback } from "./feedback";

const COMMON_ACTIONS = ["inspect", "claim", "report"] as const;
const ROOT_ACTIONS = ["delegate"] as const;
type CollaborateAction = (typeof COMMON_ACTIONS)[number] | (typeof ROOT_ACTIONS)[number];

function currentRun(): RunPaths {
	const taskId = process.env.CODEFLOW_RUN_ID;
	if (!taskId) throw new Error("collaborate requires a Codeflow Task");
	return new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, taskId);
}

function currentGoal(paths: RunPaths): string {
	return process.env.CODEFLOW_GOAL_ID ?? paths.runId;
}

function currentExecution(): string {
	const executionId = process.env.CODEFLOW_EXECUTION_ID;
	if (!executionId) throw new Error("collaborate requires a Worker execution");
	return executionId;
}

function dependenciesCompleted(paths: RunPaths, goalId: string): boolean {
	if (goalId === paths.runId) return true;
	return goalState(paths, goalId).dependencies.every(
		(dependency) => goalState(paths, dependency).status === "completed",
	);
}

function delegatedCommitments(paths: RunPaths, parentCommitmentId: string) {
	return commitmentHistory(paths).filter(
		(view) => view.commitment.parent_commitment_id === parentCommitmentId,
	);
}

function result(value: unknown, details?: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details,
	};
}

const StringArray = Type.Array(Type.String({ minLength: 1 }));
const Effect = Type.Union([
	Type.Object({ git: Type.String({ minLength: 1 }) }),
	Type.Object({ file: Type.String({ minLength: 1 }) }),
	Type.Object({ external: Type.String({ minLength: 1 }) }),
	Type.Object({ service: Type.Record(Type.String(), Type.Unknown()) }),
]);
const ReceiptStatus = Type.Union([
	Type.Literal("progress"),
	Type.Literal("completed"),
	Type.Literal("blocked"),
]);

const ACTION_SCHEMAS = {
	inspect: Type.Object({
		name: Type.Literal("inspect"),
		goal_id: Type.Optional(Type.String({ minLength: 1 })),
		commitment_id: Type.Optional(Type.String({ minLength: 1 })),
		receipt_id: Type.Optional(Type.String({ minLength: 1 })),
	}, { additionalProperties: false, description: "Recall a Goal, Commitment, or Receipt by id. Omit ids for the current Goal." }),
	claim: Type.Object({
		name: Type.Literal("claim"),
		work: Type.String({ minLength: 1, maxLength: 600 }),
		done_when: Type.Optional(StringArray),
		constraints: Type.Optional(StringArray),
	}, { additionalProperties: false, description: "Create this Worker's bounded Commitment." }),
	report: Type.Object({
		name: Type.Literal("report"),
		status: ReceiptStatus,
		summary: Type.String({ minLength: 1 }),
		effects: Type.Optional(Type.Array(Effect)),
		remaining: Type.Optional(StringArray),
	}, { additionalProperties: false, description: "Report progress, completion, or a blocker. Before claim, only blocked is valid." }),
	delegate: Type.Object({
		name: Type.Literal("delegate"),
		goal_id: Type.Optional(Type.String({ minLength: 1 })),
		new_goal: Type.Optional(Type.Object({
			goal_id: Type.String({ minLength: 1 }),
			objective: Type.String({ minLength: 1 }),
			dependencies: Type.Optional(StringArray),
		}, { additionalProperties: false })),
		focus: Type.String({ minLength: 1 }),
		resume_commitment_id: Type.Optional(Type.String({ minLength: 1 })),
	}, {
		additionalProperties: false,
		description: "Root only: start a Worker. Set exactly one of goal_id (reuse) or new_goal (create).",
	}),
} as const;

function parameters(root: boolean) {
	const actions = root ? [...COMMON_ACTIONS, ...ROOT_ACTIONS] : [...COMMON_ACTIONS];
	return Type.Object({
		action: Type.Union(actions.map((action) => ACTION_SCHEMAS[action])),
	}, { additionalProperties: false });
}

export default function (pi: ExtensionAPI) {
	const root = process.env.CODEFLOW_PROCESS_KIND === "root";
	// Pass the same launcher instance: Pi loads separate extensions in isolated caches.
	if (root) registerWorkerFeedback(pi, { cancelWorkers, hasLiveWorkers, takeWorkerUpdates });
	pi.registerTool({
		name: "collaborate",
		label: "Collaborate",
		description: root
			? "Coordinate Goal-scoped work. Use inspect, claim, report, or delegate. Root alone can create Goals and delegate Workers."
			: "Coordinate Goal-scoped work. Use inspect, claim, or report.",
		parameters: parameters(root),
		async execute(_id, rawParams, signal, _update, ctx) {
			const params = (rawParams as { action: Record<string, unknown> }).action;
			const action = params.name as CollaborateAction;
			const allowed = root ? [...COMMON_ACTIONS, ...ROOT_ACTIONS] : [...COMMON_ACTIONS];
			if (!(allowed as readonly string[]).includes(action)) {
				throw new Error(`collaborate action is unavailable to this Worker: ${String(action)}`);
			}
			const paths = currentRun();
			switch (action) {
				case "inspect": {
					const ids = [params.goal_id, params.commitment_id, params.receipt_id].filter(Boolean);
					if (ids.length > 1) throw new Error("inspect accepts at most one of goal_id, commitment_id, or receipt_id");
					if (params.receipt_id) return result(inspectReceipt(paths, params.receipt_id as string));
					if (params.commitment_id) return result(inspectCommitment(paths, params.commitment_id as string));
					return result(inspectGoal(paths, (params.goal_id as string | undefined) ?? currentGoal(paths)));
				}
				case "claim": {
					const executionId = currentExecution();
					const goalId = currentGoal(paths);
					if (!dependenciesCompleted(paths, goalId)) throw new Error(`goal dependencies are not completed: ${goalId}`);
					if (loadWorkerReport(paths, executionId)) throw new Error("a Worker that reported a blocker cannot claim in the same execution");
					const currentId = process.env.CODEFLOW_COMMITMENT_ID;
					if (currentId && !loadTerminalReceipt(paths, currentId)) {
						throw new Error(`current Commitment is still open: ${currentId}`);
					}
					const commitment = claimCommitment(paths, {
						goalId,
						workerExecutionId: executionId,
						basedOnRevision: goalClaimRevision(paths, goalId),
						work: params.work as string,
						doneWhen: params.done_when as string[] | undefined,
						constraints: params.constraints as string[] | undefined,
						parentCommitmentId: process.env.CODEFLOW_PARENT_COMMITMENT_ID ?? null,
					});
					process.env.CODEFLOW_COMMITMENT_ID = commitment.id;
					return result({ commitment_id: commitment.id, goal_id: commitment.goal_id });
				}
				case "report": {
					const commitmentId = process.env.CODEFLOW_COMMITMENT_ID;
					const status = params.status as Parameters<typeof submitReceipt>[1]["status"];
					if (!commitmentId) {
						if (status !== "blocked") throw new Error("a pre-claim report must be blocked");
						return result(writeWorkerReport(paths, {
							goal_id: currentGoal(paths),
							execution_id: currentExecution(),
							summary: params.summary as string,
							remaining: (params.remaining as string[] | undefined) ?? [],
						}));
					}
					if (root && status !== "progress") {
						const children = delegatedCommitments(paths, commitmentId);
						if (children.length === 0) {
							throw new Error("terminal Root Receipt requires at least one Child Worker Commitment");
						}
						if (hasLiveWorkers() || children.some((child) => child.folded.terminal === null)) {
							throw new Error("terminal Root Receipt requires every delegated Worker and Child Commitment to finish");
						}
					}
					const receipt = submitReceipt(paths, {
						commitmentId,
						status,
						summary: params.summary as string,
						effects: params.effects as Parameters<typeof submitReceipt>[1]["effects"],
						remaining: params.remaining as string[] | undefined,
					});
					return result({ receipt_id: receipt.id, status: receipt.status });
				}
				case "delegate": {
					const parentId = process.env.CODEFLOW_COMMITMENT_ID;
					if (!parentId) throw new Error("delegate requires the Root Worker to claim its own Commitment first");
					if (loadReceiptChain(paths, parentId).terminal) throw new Error("delegate requires an open current Commitment");
					const existingGoalId = params.goal_id as string | undefined;
					const newGoal = params.new_goal as {
						goal_id: string;
						objective: string;
						dependencies?: string[];
					} | undefined;
					if ((existingGoalId === undefined) === (newGoal === undefined)) {
						throw new Error("delegate requires exactly one of goal_id or new_goal");
					}
					let goalId: string;
					if (newGoal) {
						goalId = newGoal.goal_id;
						createGoal(paths, {
							id: goalId,
							objective: newGoal.objective,
							dependencies: newGoal.dependencies,
						});
					} else {
						goalId = existingGoalId as string;
						goalState(paths, goalId);
					}
					if (!dependenciesCompleted(paths, goalId)) {
						return result({ goal_id: goalId, status: "waiting", execution_id: null });
					}
					const execution = delegateWorker({
						goalId,
						focus: params.focus as string,
						parentCommitmentId: parentId,
						resumeCommitmentId: params.resume_commitment_id as string | undefined,
					}, signal, ctx.cwd);
					return result(execution, execution);
				}
			}
		},
	});
}
