import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { recallGoal } from "../../lib/recall";
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
		description: "Close the current Handoff with its minimal semantic outcome and natural Effect references.",
		parameters: Type.Object({
			status: Type.Union([
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
		}),
		async execute(_id, params) {
			const handoffId = process.env.CODEFLOW_HANDOFF_ID;
			if (!handoffId) throw new Error("receipt requires a current Handoff");
			const receipt = submitReceipt(currentRun(), { handoffId, ...params });
			return { content: [{ type: "text", text: JSON.stringify({ receipt_id: receipt.id, status: receipt.status }) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "recall",
		label: "Recall Goal",
		description: "Explicitly recall another Goal by goal_id. Start with state or semantic; use full only when needed.",
		parameters: Type.Object({
			goal_id: Type.String({ minLength: 1 }),
			level: Type.Optional(Type.Union([Type.Literal("state"), Type.Literal("semantic"), Type.Literal("full")])),
		}),
		async execute(_id, params) {
			const result = recallGoal(currentRun(), params.goal_id, params.level ?? "state");
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
		},
	});
}
