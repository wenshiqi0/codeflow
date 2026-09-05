/** Deterministic, network-free provider for exercising the real Pi agent loop. */

import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";

const provider = fauxProvider({
	api: "codemark-offline-api",
	provider: "codemark-offline",
	models: [{
		id: "manager",
		name: "Codemark Offline Manager",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	}],
});

provider.setResponses([
	() => {
		const runId = process.env.CODEMARK_RUN_ID;
		if (!runId) throw new Error("offline provider requires CODEMARK_RUN_ID");
		if (process.env.CODEMARK_OFFLINE_SCENARIO === "zero-workers") {
			return fauxAssistantMessage([{ type: "text", text: "No delegation proposed." }]);
		}
		if (process.env.CODEMARK_OFFLINE_SCENARIO === "leaf") {
			return fauxAssistantMessage([
				fauxToolCall("collaborate", {
					action: { name: "claim", work: "answer the bounded repository question locally" },
				}, { id: "offline-leaf-claim" }),
				fauxToolCall("collaborate", {
					action: { name: "report", status: "completed", summary: "Local analysis is sufficient; no independent subtask is needed" },
				}, { id: "offline-leaf-report" }),
			]);
		}
		if (process.env.CODEMARK_OFFLINE_SCENARIO === "identity-probe") {
			const runDir = process.env.CODEMARK_RUN_DIR;
			if (!runDir) throw new Error("identity probe requires private run state");
			const privateCanary = path.join(runDir, "harness-only.txt");
			const privateLink = path.join(process.cwd(), "private-state-link");
			fs.writeFileSync(privateCanary, "HARNESS_ONLY_CANARY", "utf8");
			fs.symlinkSync(privateCanary, privateLink);
			return fauxAssistantMessage([
				fauxToolCall("read", { path: "inside.txt" }, { id: "offline-read-inside" }),
				fauxToolCall("read", { path: privateCanary }, { id: "offline-read-private" }),
				fauxToolCall("read", { path: privateLink }, { id: "offline-read-private-link" }),
				fauxToolCall("read", { path: "/proc/self/environ" }, { id: "offline-read-environ" }),
				fauxToolCall("read", { path: "/proc/self/cmdline" }, { id: "offline-read-cmdline" }),
				fauxToolCall("read", { path: path.join(process.env.CODEFLOW_HOME ?? "", ".env") }, { id: "offline-read-env-file" }),
			]);
		}
		if (process.env.CODEMARK_OFFLINE_SCENARIO === "coercible-arguments") {
			return fauxAssistantMessage([
				fauxToolCall("collaborate", {
					action: { name: "claim", work: 123, done_when: "frontier frozen" },
				}, { id: "offline-coercible-claim" }),
				fauxToolCall("collaborate", {
					action: { name: "delegate", goal_id: runId, focus: 456 },
				}, { id: "offline-coercible-delegate" }),
			]);
		}
		return fauxAssistantMessage([
			fauxToolCall("collaborate", {
				action: { name: "claim", work: "organize the initial work" },
			}, { id: "offline-claim" }),
			fauxToolCall("collaborate", {
				action: { name: "delegate", goal_id: runId, focus: "inspect the issue boundary" },
			}, { id: "offline-delegate" }),
			fauxToolCall("read", { path: "README.md" }, { id: "offline-read" }),
		]);
	},
	(context) => {
		if (process.env.CODEMARK_OFFLINE_SCENARIO !== "identity-probe") {
			const scenario = process.env.CODEMARK_OFFLINE_SCENARIO;
			if (scenario === "provider-error") throw new Error("offline provider failure");
			if (scenario === "multi-step") return fauxAssistantMessage([
				fauxToolCall("collaborate", {
					action: { name: "delegate", goal_id: process.env.CODEMARK_RUN_ID, focus: "independent verification after inspecting initial tool feedback" },
				}),
			]);
			if (scenario === "length") return fauxAssistantMessage([], { stopReason: "length" });
			if (scenario === "length-with-tools") return fauxAssistantMessage([
				fauxToolCall("collaborate", {
					action: { name: "delegate", goal_id: process.env.CODEMARK_RUN_ID, focus: "truncated proposal must not execute" },
				}),
			], { stopReason: "length" });
			if (scenario === "aborted") return fauxAssistantMessage([], { stopReason: "aborted" });
			return fauxAssistantMessage([{ type: "text", text: "Initial organization is ready." }]);
		}
		const runId = process.env.CODEMARK_RUN_ID;
		const codeflowHome = process.env.CODEFLOW_HOME;
		if (!runId || !codeflowHome) throw new Error("identity probe requires run and output roots");
		const resultText = context.messages
			.filter((message) => message.role === "toolResult")
			.flatMap((message) => message.content)
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		const publicArtifact = path.join(
			codeflowHome,
			"codemark",
			"runs",
			runId,
			"initial-organization.json",
		);
		const passed = resultText.includes("INSIDE_REPOSITORY_CANARY")
			&& !resultText.includes("HARNESS_ONLY_CANARY")
			&& !resultText.includes("PROC_ENV_CANARY")
			&& !resultText.includes("CODEMARK_RUN_DIR")
			&& !resultText.includes("codemark/extensions/")
			&& !fs.existsSync(publicArtifact)
			&& !fs.existsSync(path.join(process.cwd(), ".codemark"));
		return fauxAssistantMessage([
			fauxToolCall("collaborate", {
				action: {
					name: "claim",
					work: passed ? "identity boundary passed" : "identity boundary failed",
				},
			}, { id: "offline-identity-claim" }),
			fauxToolCall("collaborate", {
				action: { name: "delegate", goal_id: runId, focus: "inspect the repository boundary" },
			}, { id: "offline-identity-delegate" }),
		]);
	},
	() => fauxAssistantMessage([{ type: "text", text: "Initial organization is ready." }]),
	() => { throw new Error("unexpected Manager continuation after natural turn end"); },
]);

export default function (pi: ExtensionAPI): void {
	pi.registerProvider(provider.provider);
}
