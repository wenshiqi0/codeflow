/**
 * Pi extension that registers process-scoped organization tools.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { delegationPointer } from "./handoff-gate";
import { defineGoal, GoalError } from "../../lib/goals";
import { currentRun } from "./shared";
import { finishHandoff } from "../../lib/handoff";
import {
	assertThreadAvailable,
	handoffHistory,
	openHandoff,
	reconcileHandoff,
	resolveGoalTask,
	TaskContractError,
	type GoalTaskRef,
} from "./registry";
import { runRoleChild, type TaskDetails } from "./role-launcher";

export const MAX_CONCURRENCY = 8;
export const MAX_TASK_PROMPT_CHARS = 4_000;

type ToolResult<T> = AgentToolResult<T | undefined>;

const RUNTIME_FAILURE_MESSAGE =
	"Codeflow runtime failure. The root handoff is now BLOCKED; stop immediately and do not retry or repair Codeflow.";

export function taskResolutionFailure(error: unknown): never {
	if (error instanceof GoalError || error instanceof TaskContractError) {
		throw error;
	}
	const paths = currentRun();
	const rootHandoffId = process.env.CODEFLOW_HANDOFF_ID;
	if (paths && rootHandoffId) {
		try {
			finishHandoff(paths, {
				handoffId: rootHandoffId,
				status: "BLOCKED",
				blockedReasons: ["PROVIDER_FAILURE"],
				summary: "Codeflow runtime failure",
				detail: "The task tool failed inside the Codeflow runtime.",
			});
		} catch {
			// The generic terminal result remains fail-closed even if event closing
			// itself fails; the depth-0 runner exit gate will block the root.
		}
	}
	throw new Error(RUNTIME_FAILURE_MESSAGE);
}

const TaskParams = Type.Object({
	prompt: Type.String({
		minLength: 1,
		maxLength: MAX_TASK_PROMPT_CHARS,
		description: "Outcome handoff for another worker; maximum 4000 characters",
	}),
	goal_id: Type.Optional(Type.String({
		description: "Existing goal contract id; omitted tasks run in the _ungrouped scope",
	})),
	thread: Type.Optional(Type.String({
		description: "Stable thread id: same goal and thread continue a session; omitted starts a fresh thread",
	})),
});

const GoalParams = Type.Object({
	id: Type.String({ description: "Stable goal id, for example movement-r1" }),
	goal: Type.String({ description: "One observable outcome grouped under this goal" }),
	definition_of_done: Type.Optional(Type.Array(Type.String(), {
		description: "Human-readable completion conditions; this field carries no mechanical gate",
	})),
});

const TaskGroupParams = Type.Object({
	tasks: Type.Array(
		Type.Object({
			prompt: Type.String({
				minLength: 1,
				maxLength: MAX_TASK_PROMPT_CHARS,
				description: "Outcome handoff for another worker; maximum 4000 characters",
			}),
			goal_id: Type.Optional(Type.String({
				description: "Existing goal contract id; omitted tasks run in the _ungrouped scope",
			})),
			thread: Type.Optional(Type.String({
				description: "Stable thread id: same goal and thread continue a session; omitted starts a fresh thread",
			})),
		}),
	),
	max_concurrency: Type.Optional(
		Type.Number({ description: "Maximum concurrent children (default 3, minimum 1, maximum 8)" }),
	),
});

export function assertTaskPrompt(prompt: string): void {
	if (prompt.trim() === "") throw new TaskContractError("task prompt must not be empty");
	if (prompt.length > MAX_TASK_PROMPT_CHARS) {
		throw new TaskContractError(
			`task prompt exceeds ${MAX_TASK_PROMPT_CHARS} characters; keep outcomes and constraints, and leave specialist discovery to the receiving role`,
		);
	}
}

export function childHandoffPrompt(
	prompt: string,
	handoffId: string | undefined,
	goal: GoalTaskRef | null,
): string {
	if (!goal || !handoffId) return prompt;
	const paths = currentRun();
	if (!paths) return prompt;
	const hasEarlierThreadHandoff = handoffHistory(paths).some(
		(state) =>
			state.handoff_id !== handoffId &&
			state.goal_id === goal.goalId &&
			state.thread === goal.thread,
	);
	if (!hasEarlierThreadHandoff) return prompt;
	const title = prompt.split("\n", 1)[0].slice(0, 160);
	return `handoff ${handoffId} opened for goal ${goal.goalId} thread ${goal.thread}: ${title}\nRead the full contract with: code-agent handoff body --id ${handoffId}`;
}

export default function (pi: ExtensionAPI) {
	// Organization is a process-position capability. Children always run at
	// depth 1, so they never receive these tools.
	const depth = Number(process.env.CODEFLOW_AGENT_DEPTH ?? "0");
	if (!Number.isFinite(depth) || depth !== 0) return;

	pi.registerTool({
		name: "goal",
		label: "Goal",
		description:
			"Create an immutable goal grouping contract. A goal has no state machine or mechanical join gate.",
		parameters: GoalParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult<unknown>> {
			const paths = currentRun();
			if (!paths) throw new Error("goal contracts require a Codeflow run");
			try {
				const previousCwd = process.cwd();
				process.chdir(ctx.cwd);
				try {
					const result = defineGoal(paths, {
						id: params.id,
						goal: params.goal,
						definitionOfDone: params.definition_of_done,
					});
					return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
				} finally {
					process.chdir(previousCwd);
				}
			} catch (error) {
				throw error instanceof Error ? error : new Error(String(error));
			}
		},
	});

	pi.registerTool({
		name: "task",
		label: "Task",
		description:
			"Open a task handoff to another worker. " +
			"The worker runs in an isolated pi child process. Same goal/thread continues a session; a new or omitted thread is fresh.",
		parameters: TaskParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolResult<TaskDetails>> {
			const agent = "worker";
			const details: TaskDetails = { exitCode: 1, stderr: "" };

			let goal: GoalTaskRef | null = null;
			try {
				assertTaskPrompt(params.prompt);
				goal = resolveGoalTask(params.goal_id, params.thread);
				if (goal) assertThreadAvailable(goal);
			} catch (error) {
				taskResolutionFailure(error);
			}
			details.goalId = goal?.goalId;
			details.thread = goal?.thread;
			details.sessionId = goal?.sessionId;

			const paths = currentRun();
			const handoff = openHandoff(agent, params.prompt, ctx.cwd, goal ?? undefined);
			const childPrompt = childHandoffPrompt(params.prompt, handoff?.handoffId, goal);
			const result = await runRoleChild(
				agent,
				childPrompt,
				signal,
				ctx.cwd,
				handoff?.handoffId,
				goal && paths ? { id: goal.sessionId, dir: paths.piSessions } : undefined,
				goal ?? undefined,
			);
			details.exitCode = result.exitCode;
			details.stopReason = result.stopReason;
			details.stderr = result.stderr;
			details.handoffId = handoff?.handoffId;

			// Without a registry there is no pointer to return, so the child's
			// text stays the result; this is the unregistered fallback path.
			if (!handoff) {
				if (!result.success) throw new Error(result.content);
				return { content: [{ type: "text", text: result.content }], details };
			}

			const reconciled = reconcileHandoff(handoff, result, ctx.cwd);
			details.handoffStatus = reconciled.status;
			const pointer = delegationPointer(
				handoff.handoffId,
				reconciled.status,
				reconciled.reasons,
				reconciled.receipt,
				handoff.statePath,
			);
			const text = JSON.stringify(pointer);
			if (reconciled.status !== "PASS") throw new Error(text);
			return { content: [{ type: "text", text }], details };
		},
	});

	pi.registerTool({
		name: "task_group",
		label: "Task Group",
		description:
			"Run multiple independent Codeflow role tasks concurrently with bounded " +
			"concurrency. Each task spawns an isolated pi child like the task tool. " +
			"Results are reported as a JSON array in input order, one entry per task " +
			"with success, content, and exitCode.",
		parameters: TaskGroupParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolResult<unknown>> {
			const tasks = params.tasks;
			const maxConcurrent = Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(params.max_concurrency ?? 3)));
			const results: Array<Record<string, unknown>> = new Array(tasks.length);
			let wasAborted = false;
			const abortListener = () => { wasAborted = true; };
			if (signal) {
				if (signal.aborted) wasAborted = true;
				else signal.addEventListener("abort", abortListener);
			}

			// Bounded worker pool: at most maxConcurrent children run at a time.
			// The shared cursor hands out input indexes so results[i] always
			// preserves the original task order.
			let cursor = 0;
			const worker = async () => {
				while (true) {
					const index = cursor++;
					if (index >= tasks.length) return;
					const task = tasks[index];
					if (signal?.aborted) {
						results[index] = {
							success: false,
							content: "Task was aborted by cancellation before it started.",
							exitCode: 1,
						};
						continue;
					}
					const agent = "worker";
					let goal: GoalTaskRef | null = null;
					try {
						assertTaskPrompt(task.prompt);
						goal = resolveGoalTask(task.goal_id, task.thread);
						if (goal) assertThreadAvailable(goal);
					} catch (error) {
						if (!(error instanceof GoalError) && !(error instanceof TaskContractError)) {
							taskResolutionFailure(error);
						}
					results[index] = {
						success: false,
							content: error instanceof Error ? error.message : String(error),
							exitCode: 1,
						};
						continue;
					}
					const paths = currentRun();
					const handoff = openHandoff(agent, task.prompt, ctx.cwd, goal ?? undefined);
					const childPrompt = childHandoffPrompt(task.prompt, handoff?.handoffId, goal);
					const result = await runRoleChild(
						agent,
						childPrompt,
						signal,
						ctx.cwd,
						handoff?.handoffId,
						goal && paths ? { id: goal.sessionId, dir: paths.piSessions } : undefined,
						goal ?? undefined,
					);
					if (!handoff) {
						results[index] = {
							success: result.success,
							content: result.content,
							exitCode: result.exitCode,
						};
						continue;
					}
					const reconciled = reconcileHandoff(handoff, result, ctx.cwd);
					results[index] = {
						...delegationPointer(
							handoff.handoffId,
							reconciled.status,
							reconciled.reasons,
							reconciled.receipt,
							handoff.statePath,
						),
					};
				}
			};

			const workers: Array<Promise<void>> = [];
			for (let i = 0; i < Math.min(maxConcurrent, tasks.length); i++) {
				workers.push(worker());
			}

			try {
				await Promise.all(workers);
			} finally {
				signal?.removeEventListener("abort", abortListener);
				// Orphan prevention: every child registers an abort listener that
				// kills its process, and runRoleChild only resolves after the
				// child closed, so reaching this point means no child is left
				// running. If the signal aborted mid-flight, kill propagation
				// already happened inside runRoleChild.
			}

			if (wasAborted) {
				throw new Error(
					"task_group was aborted by cancellation; running children were killed.",
				);
			}

			return {
				content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
				details: undefined,
			};
		},
	});
}
