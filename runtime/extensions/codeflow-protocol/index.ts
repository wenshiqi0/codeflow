import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { recallGoal, recallHandoff, recallReceipt } from "../../lib/recall";
import { submitReceipt } from "../../lib/handoff";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";

function currentRun(): RunPaths {
	const taskId = process.env.CODEFLOW_RUN_ID;
	if (!taskId) throw new Error("Codeflow protocol requires a task");
	return new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, taskId);
}

const StringArray = Type.Array(Type.String({ minLength: 1 }));
const Effect = Type.Union([
	Type.Object({ git: Type.String({ minLength: 1 }) }),
	Type.Object({ file: Type.String({ minLength: 1 }) }),
	Type.Object({ external: Type.String({ minLength: 1 }) }),
	Type.Object({ semantic: Type.String({ minLength: 1 }) }),
	Type.Object({ service: Type.Record(Type.String(), Type.Unknown()) }),
]);

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "receipt",
		label: "Receipt",
		description: "Append one Receipt to the current Handoff. `progress` advances durable semantics without closing it; completed, partial, blocked, failed, or superseded closes it.",
		parameters: Type.Object({
			status: Type.Union([
				Type.Literal("progress"),
				Type.Literal("completed"),
				Type.Literal("partial"),
				Type.Literal("blocked"),
				Type.Literal("failed"),
				Type.Literal("superseded"),
			]),
			effects: Type.Optional(Type.Array(Effect)),
			established: Type.Optional(StringArray),
			decisions: Type.Optional(StringArray),
			discovered: Type.Optional(StringArray),
			unresolved: Type.Optional(StringArray),
			blockers: Type.Optional(StringArray),
			resolved: Type.Optional(StringArray),
			resolvedUnresolved: Type.Optional(StringArray),
			resolvedBlockers: Type.Optional(StringArray),
		}),
		async execute(_id, params) {
			const handoffId = process.env.CODEFLOW_HANDOFF_ID;
			if (!handoffId) throw new Error("receipt requires a current Handoff");
			const receipt = submitReceipt(currentRun(), {
				handoffId,
				status: params.status,
				effects: params.effects,
				established: params.established,
				decisions: params.decisions,
				discovered: params.discovered,
				unresolved: params.unresolved,
				blockers: params.blockers,
				resolved: params.resolved,
				resolvedUnresolved: params.resolvedUnresolved,
				resolvedBlockers: params.resolvedBlockers,
			});
			return { content: [{ type: "text", text: JSON.stringify({ receipt_id: receipt.id, status: receipt.status }) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "recall",
		label: "Recall",
		description: "Explicitly recall a Goal, a Handoff, or an exact Receipt. Goal semantic recall returns the latest Handoff's folded Receipt state, not the whole delta chain; use full only when the complete history is needed.",
		parameters: Type.Object({
			goal_id: Type.Optional(Type.String({ minLength: 1 })),
			handoff_id: Type.Optional(Type.String({ minLength: 1 })),
			receipt_id: Type.Optional(Type.String({ minLength: 1 })),
			level: Type.Optional(Type.Union([Type.Literal("state"), Type.Literal("semantic"), Type.Literal("full")])),
		}),
		async execute(_id, params) {
			const paths = currentRun();
			let result: unknown;
			if (params.receipt_id) {
				result = recallReceipt(paths, params.receipt_id, params.handoff_id)
					?? { error: `unknown receipt: ${params.receipt_id}` };
			} else if (params.handoff_id) {
				result = recallHandoff(paths, params.handoff_id, params.level ?? "state");
			} else {
				result = recallGoal(paths, params.goal_id ?? process.env.CODEFLOW_GOAL_ID ?? paths.runId, params.level ?? "state");
			}
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
		},
	});
}
