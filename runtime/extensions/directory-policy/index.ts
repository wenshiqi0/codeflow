/**
 * Pi extension that turns role frontmatter and immutable goal contracts into
 * pre-execution filesystem boundaries.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bashViolation, pathViolation } from "./policy";

const VIOLATION_TYPE = "codeflow:directory_policy_violation";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		const role = process.env.CODEFLOW_AGENT_ROLE;
		const cwd = process.cwd();
		const goalId = process.env.CODEFLOW_GOAL_ID;
		const lane = process.env.CODEFLOW_LANE;
		let reason: string | null = null;

		if (event.toolName === "write" || event.toolName === "edit") {
			const target = (event.input as { path?: unknown }).path;
			if (typeof target === "string") {
				reason = pathViolation(role, cwd, target, goalId, lane);
			}
		} else if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown }).command;
			if (typeof command === "string") {
				reason = bashViolation(role, command);
			}
		}

		if (!reason) return undefined;
		pi.appendEntry(VIOLATION_TYPE, {
			role,
			goal_id: goalId ?? null,
			lane: lane ?? null,
			tool: event.toolName,
			reason,
		});
		return { block: true, reason, terminate: true };
	});
}
