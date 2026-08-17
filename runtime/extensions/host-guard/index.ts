/** Fails closed when a role tries to inspect or modify the host Codeflow runtime. */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	redactRuntimeReferences,
	runtimeBashViolation,
	runtimeReadViolation,
	runtimeWriteViolation,
} from "./policy";

const VIOLATION_TYPE = "codeflow:host_runtime_violation";

export default function (pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		let reason: string | null = null;
		if (event.toolName === "write" || event.toolName === "edit") {
			const target = (event.input as { path?: unknown }).path;
			if (typeof target === "string") reason = runtimeWriteViolation(target);
		} else if (event.toolName === "read") {
			const target = (event.input as { path?: unknown }).path;
			if (typeof target === "string") reason = runtimeReadViolation(target);
		} else if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown }).command;
			if (typeof command === "string") reason = runtimeBashViolation(command);
		}
		if (!reason) return undefined;
		pi.appendEntry(VIOLATION_TYPE, { tool: event.toolName, reason });
		return { block: true, reason, terminate: true };
	});

	pi.on("tool_result", (event) => {
		let changed = false;
		const content = event.content.map((part) => {
			if (part.type !== "text") return part;
			const text = redactRuntimeReferences(part.text);
			if (text === part.text) return part;
			changed = true;
			return { ...part, text };
		});
		return changed ? { content } : undefined;
	});
}
