/**
 * Pi extension that registers the planner-facing goal/task/task_group tools.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { delegationPointer } from "./handoff-gate";
import { defineGoal, GoalError } from "../../lib/goals";
import { currentRun } from "./shared";
import { finishHandoff } from "../../lib/handoff";
import {
	assertGoalLaneAvailable,
	openHandoff,
	reconcileHandoff,
	resolveGoalTask,
	TaskContractError,
	type GoalTaskRef,
} from "./registry";
import { roleMayDelegate, runRoleChild, type TaskDetails } from "./role-launcher";

const MAX_CONCURRENCY = 8;

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
	agent: Type.String({ description: "Codeflow role name; resolved to agents/<role>.md by filename" }),
	prompt: Type.String({ description: "Task prompt handed to the role" }),
	goal_id: Type.Optional(Type.String({
		description: "Goal contract id; use only with tester/coder/verify and omit for architect",
	})),
	lane: Type.Optional(Type.String({
		description: "Goal lane: test, code, or verify; omit for architect, which owns no lane",
	})),
});

const GoalParams = Type.Object({
	id: Type.String({ description: "Stable goal id, for example movement-r1" }),
	goal: Type.String({ description: "One observable goal pursued by this goal's agent group" }),
	definition_of_done: Type.Optional(Type.Array(Type.String(), {
		description: "Human-readable completion conditions; join status comes from handoffs",
	})),
});

const TaskGroupParams = Type.Object({
	tasks: Type.Array(
		Type.Object({
			agent: Type.String({ description: "Codeflow role name" }),
			prompt: Type.String({ description: "Task prompt for the role" }),
			goal_id: Type.Optional(Type.String({
				description: "Goal contract id; omit for architect",
			})),
			lane: Type.Optional(Type.String({
				description: "Goal lane: test, code, or verify; omit for architect",
			})),
		}),
	),
	max_concurrency: Type.Optional(
		Type.Number({ description: "Maximum concurrent children (default 3, minimum 1, maximum 8)" }),
	),
});

export default function (pi: ExtensionAPI) {
	// Delegation is an explicit role permission and is available only at depth
	// 0. Children always run at depth 1, so they can never re-register tools
	// even if their role frontmatter also contains `delegates: true`.
	const role = process.env.CODEFLOW_AGENT_ROLE;
	const depth = Number(process.env.CODEFLOW_AGENT_DEPTH ?? "0");
	if (!roleMayDelegate(role, depth)) return;

	pi.registerTool({
		name: "goal",
		label: "Goal",
		description:
			"Create an immutable goal contract. The goal has no state machine; " +
			"progress is derived by joining its test/code/verify handoffs.",
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
			"Delegate a task to a named Codeflow role. " +
			"The role runs in an isolated pi child process with its own context. " +
			"Architect is an unlaned advisory role: omit goal_id and lane when delegating to it.",
		parameters: TaskParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolResult<TaskDetails>> {
			const agent = params.agent.trim();
			const details: TaskDetails = { agent, exitCode: 1, stderr: "" };

			let goal: GoalTaskRef | null = null;
			try {
				goal = resolveGoalTask(agent, params.goal_id, params.lane);
				if (goal) assertGoalLaneAvailable(goal);
			} catch (error) {
				taskResolutionFailure(error);
			}
			details.goalId = goal?.goalId;
			details.lane = goal?.lane;
			details.sessionId = goal?.sessionId;

			const paths = currentRun();
			const handoff = openHandoff(agent, params.prompt, ctx.cwd, goal ?? undefined);
			const result = await runRoleChild(
				agent,
				params.prompt,
				signal,
				ctx.cwd,
				handoff?.handoffId,
				goal && paths ? { id: goal.sessionId, dir: paths.piSessions } : undefined,
				goal ?? undefined,
			);
			details.agent = result.agent;
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
			"with agent, success, content, and exitCode.",
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
							agent: task.agent.trim(),
							success: false,
							content: "Task was aborted by cancellation before it started.",
							exitCode: 1,
						};
						continue;
					}
					const agent = task.agent.trim();
					let goal: GoalTaskRef | null = null;
					try {
						goal = resolveGoalTask(agent, task.goal_id, task.lane);
						if (goal) assertGoalLaneAvailable(goal);
					} catch (error) {
						if (!(error instanceof GoalError) && !(error instanceof TaskContractError)) {
							taskResolutionFailure(error);
						}
						results[index] = {
							agent,
							success: false,
							content: error instanceof Error ? error.message : String(error),
							exitCode: 1,
						};
						continue;
					}
					const paths = currentRun();
					const handoff = openHandoff(agent, task.prompt, ctx.cwd, goal ?? undefined);
					const result = await runRoleChild(
						agent,
						task.prompt,
						signal,
						ctx.cwd,
						handoff?.handoffId,
						goal && paths ? { id: goal.sessionId, dir: paths.piSessions } : undefined,
						goal ?? undefined,
					);
					if (!handoff) {
						results[index] = {
							agent: result.agent,
							success: result.success,
							content: result.content,
							exitCode: result.exitCode,
						};
						continue;
					}
					const reconciled = reconcileHandoff(handoff, result, ctx.cwd);
					results[index] = {
						agent: result.agent,
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
