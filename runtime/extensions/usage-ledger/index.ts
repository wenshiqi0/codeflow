/**
 * Append every attributed assistant model response to the run usage ledger.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";
import { appendUsageRecord, usageRecordFromMessage } from "../../lib/usage";

export default function (pi: ExtensionAPI): void {
	let currentTurn = 0;

	pi.on("turn_start", (event) => {
		currentTurn = Math.max(currentTurn, Number(event.turnIndex) + 1);
	});

	pi.on("message_end", (event) => {
		const runId = process.env.CODEFLOW_RUN_ID;
		if (!runId) return;
		const turn = currentTurn > 0 ? currentTurn : 1;
		const record = usageRecordFromMessage(event.message, turn);
		if (!record) return;
		appendUsageRecord(
			new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, runId),
			record,
		);
	});
}
