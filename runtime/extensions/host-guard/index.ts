/** Fails closed when a role tries to modify the host Codeflow runtime. */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runtimeBashViolation, runtimeWriteViolation } from "./policy";

const VIOLATION_TYPE = "codeflow:host_runtime_violation";

export default function (pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		let reason: string | null = null;
		if (event.toolName === "write" || event.toolName === "edit") {
			const target = (event.input as { path?: unknown }).path;
			if (typeof target === "string") reason = runtimeWriteViolation(target);
		} else if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown }).command;
			if (typeof command === "string") reason = runtimeBashViolation(command);
		}
		if (!reason) return undefined;
		pi.appendEntry(VIOLATION_TYPE, { tool: event.toolName, reason });
		return { block: true, reason, terminate: true };
	});
}
