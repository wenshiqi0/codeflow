/**
 * Append every attributed assistant model response to the run usage ledger.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { finishHandoff } from "../../lib/handoff";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";
import { appendUsageRecord, readUsageRecords, usageRecordFromMessage } from "../../lib/usage";
import { readRoleDefinition } from "../../lib/roles";

const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROLES_FILE = path.join(RUNTIME_DIR, "roles.json");

export function resolveHandoffRoundCap(
	role: string | undefined,
	env: Record<string, string | undefined> = process.env,
): number {
	const raw = env.CODEFLOW_HANDOFF_ROUND_CAP;
	if (raw !== undefined) {
		const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Error("CODEFLOW_HANDOFF_ROUND_CAP must be a non-negative integer");
		}
		return value;
	}
	if (!role) return 0;
	try {
		return readRoleDefinition(ROLES_FILE, role)?.handoff_round_cap ?? 0;
	} catch {
		return 0;
	}
}

export default function (pi: ExtensionAPI): void {
	let currentTurn = 0;
	let roundCapPublished = false;

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

	pi.on("before_provider_request", (_event, ctx) => {
		const runId = process.env.CODEFLOW_RUN_ID;
		const handoffId = process.env.CODEFLOW_HANDOFF_ID;
		if (!runId || !handoffId || roundCapPublished) return;
		const cap = resolveHandoffRoundCap(process.env.CODEFLOW_AGENT_ROLE);
		if (cap <= 0) return;
		const paths = new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, runId);
		const rounds = readUsageRecords(paths).filter((record) => record.handoff_id === handoffId).length;
		if (rounds < cap) return;
		roundCapPublished = true;
		try {
			finishHandoff(paths, {
				handoffId,
				status: "BLOCKED",
				blockedReasons: ["CONTEXT_BUDGET_EXCEEDED"],
				summary: `handoff round cap ${cap} reached`,
				detail: `usage ledger recorded ${rounds} completed assistant rounds for ${handoffId}`,
			});
		} catch {
			// A terminal handoff is immutable; never publish a second transition.
		}
		ctx.abort();
	});
}
