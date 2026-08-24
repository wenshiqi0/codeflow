import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createGoal, prepareGoal, updateGoalDependencies } from "../../lib/goals";
import {
	loadHandoff,
	loadReceipt,
	openHandoff,
	prepareHandoff,
	recordRuntimeFailure,
} from "../../lib/handoff";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";
import { goalState } from "../../lib/state";
import { spawnWorker } from "./worker-launcher";

export const MAX_CONCURRENCY = 8;

function dependenciesCompleted(paths: RunPaths, goalId: string): boolean {
	if (goalId === paths.runId) return true;
	return goalState(paths, goalId).dependencies.every(
		(dependency) => goalState(paths, dependency).status === "completed",
	);
}

function currentRun(): RunPaths {
	const taskId = process.env.CODEFLOW_RUN_ID;
	if (!taskId) throw new Error("organization tools require a Codeflow task");
	return new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, taskId);
}

const StringArray = Type.Array(Type.String({ minLength: 1 }));
const Reference = Type.Object({
	kind: Type.String({ minLength: 1 }),
	ref: Type.String({ minLength: 1 }),
});
const InlineGoal = Type.Object({
	id: Type.String({ minLength: 1 }),
	objective: Type.String({ minLength: 1 }),
	dependencies: Type.Optional(StringArray),
});

export interface HandoffSpawnParams {
	digest: string;
	intent: string;
	known?: string[];
	references?: Array<{ kind: string; ref: string }>;
	constraints?: string[];
	expected_outcome: string[];
	evidence_requirement?: string[];
	goal?: { id: string; objective: string; dependencies?: string[] };
	goal_id?: string;
}

type WorkerLauncher = typeof spawnWorker;

/** Validate the whole compound operation before its first durable write. */
export async function executeHandoffSpawn(
	paths: RunPaths,
	params: HandoffSpawnParams,
	parentHandoffId: string | null,
	signal: AbortSignal | undefined,
	cwd: string,
	launcher: WorkerLauncher = spawnWorker,
): Promise<Awaited<ReturnType<WorkerLauncher>>> {
	if (params.goal !== undefined && params.goal_id !== undefined) {
		throw new Error("goal and goal_id are mutually exclusive");
	}
	const plannedGoal = params.goal === undefined ? null : prepareGoal(paths, params.goal);
	const goalId = plannedGoal?.id ?? params.goal_id ?? paths.runId;
	const dependencies = plannedGoal?.dependencies
		?? (goalId === paths.runId ? [] : goalState(paths, goalId).dependencies);
	if (!dependencies.every((dependency) => goalState(paths, dependency).status === "completed")) {
		throw new Error(`goal dependencies are not completed: ${goalId}`);
	}
	prepareHandoff(paths, {
		goalId,
		digest: params.digest,
		intent: params.intent,
		known: params.known,
		references: params.references,
		constraints: params.constraints,
		expectedOutcome: params.expected_outcome,
		evidenceRequirement: params.evidence_requirement,
		parentHandoffId,
	}, plannedGoal ? [plannedGoal.id] : []);

	if (params.goal) createGoal(paths, params.goal);
	const handoff = openHandoff(paths, {
		goalId,
		digest: params.digest,
		intent: params.intent,
		known: params.known,
		references: params.references,
		constraints: params.constraints,
		expectedOutcome: params.expected_outcome,
		evidenceRequirement: params.evidence_requirement,
		parentHandoffId,
	});
	try {
		return await launcher(handoff.id, signal, cwd);
	} catch {
		recordRuntimeFailure(paths, handoff.id, ["WORKER_LAUNCH_FAILURE"], "Worker launcher failed before execution");
		return {
			handoff_id: handoff.id,
			exit_code: -1,
			stop_reason: null,
			receipt_id: null,
			status: "interrupted",
			runtime_failure_reasons: ["WORKER_LAUNCH_FAILURE"],
			retryable: true,
		};
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "goal_create",
		label: "Create Goal",
		description: "Create one outcome scope in the current Task Goal Graph.",
		parameters: Type.Object({
			id: Type.String({ minLength: 1 }),
			objective: Type.String({ minLength: 1 }),
			dependencies: Type.Optional(StringArray),
		}),
		async execute(_id, params) {
			const result = createGoal(currentRun(), params);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "goal_dependencies",
		label: "Update Goal Dependencies",
		description: "Replace a Goal's outcome dependencies after validating that the graph stays acyclic.",
		parameters: Type.Object({ goal_id: Type.String({ minLength: 1 }), dependencies: StringArray }),
		async execute(_id, params) {
			const result = updateGoalDependencies(currentRun(), params.goal_id, params.dependencies);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "handoff_create",
		label: "Create Handoff",
		description: "Open a bounded Work Commitment inside the Task root or a child Goal. This does not spawn a Worker.",
		parameters: Type.Object({
			goal_id: Type.String({ minLength: 1 }),
			digest: Type.String({ minLength: 1, maxLength: 240 }),
			intent: Type.String({ minLength: 1 }),
			known: Type.Optional(StringArray),
			references: Type.Optional(Type.Array(Reference)),
			constraints: Type.Optional(StringArray),
			expected_outcome: StringArray,
			evidence_requirement: Type.Optional(StringArray),
		}),
		async execute(_id, params) {
			const record = openHandoff(currentRun(), {
				goalId: params.goal_id,
				digest: params.digest,
				intent: params.intent,
				known: params.known,
				references: params.references,
				constraints: params.constraints,
				expectedOutcome: params.expected_outcome,
				evidenceRequirement: params.evidence_requirement,
				parentHandoffId: process.env.CODEFLOW_HANDOFF_ID ?? null,
			});
			return { content: [{ type: "text", text: JSON.stringify({ handoff_id: record.id, goal_id: record.goal_id }) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "handoff_spawn",
		label: "Create Handoff and Spawn Worker",
		description: "Open one Handoff and execute it in a fresh Worker context, with an optional inline child Goal.",
		parameters: Type.Object({
			digest: Type.String({ minLength: 1, maxLength: 240 }),
			intent: Type.String({ minLength: 1 }),
			known: Type.Optional(StringArray),
			references: Type.Optional(Type.Array(Reference)),
			constraints: Type.Optional(StringArray),
			expected_outcome: StringArray,
			evidence_requirement: Type.Optional(StringArray),
			goal: Type.Optional(InlineGoal),
			goal_id: Type.Optional(Type.String({ minLength: 1 })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const result = await executeHandoffSpawn(
				currentRun(),
				params,
				process.env.CODEFLOW_HANDOFF_ID ?? null,
				signal,
				ctx.cwd,
			);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "worker_spawn",
		label: "Spawn Worker",
		description: "Execute one existing Handoff in a fresh Worker context.",
		parameters: Type.Object({ handoff_id: Type.String({ minLength: 1 }) }),
		async execute(_id, params, signal, _update, ctx) {
			const paths = currentRun();
			const handoff = loadHandoff(paths, params.handoff_id);
			if (loadReceipt(paths, handoff.id)) throw new Error(`handoff is already closed: ${handoff.id}`);
			if (!dependenciesCompleted(paths, handoff.goal_id)) {
				throw new Error(`goal dependencies are not completed: ${handoff.goal_id}`);
			}
			const result = await spawnWorker(handoff.id, signal, ctx.cwd);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "worker_group",
		label: "Spawn Worker Group",
		description: "Execute independent existing Handoffs concurrently in fresh Worker contexts.",
		parameters: Type.Object({
			handoff_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
			max_concurrency: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_CONCURRENCY })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const ids = [...new Set(params.handoff_ids)];
			const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(params.max_concurrency ?? 3)));
			const results: unknown[] = new Array(ids.length);
			let cursor = 0;
			const runOne = async () => {
				while (cursor < ids.length) {
					const index = cursor++;
					const paths = currentRun();
					const handoff = loadHandoff(paths, ids[index]);
					if (loadReceipt(paths, handoff.id)) throw new Error(`handoff is already closed: ${handoff.id}`);
					if (!dependenciesCompleted(paths, handoff.goal_id)) {
						throw new Error(`goal dependencies are not completed: ${handoff.goal_id}`);
					}
					results[index] = await spawnWorker(handoff.id, signal, ctx.cwd);
				}
			};
			await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, runOne));
			return { content: [{ type: "text", text: JSON.stringify(results) }], details: undefined };
		},
	});
}
