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
				fauxToolCall("collaborate", {
					action: { name: "wait" },
				}, { id: "offline-coercible-wait" }),
			]);
		}
		if (process.env.CODEMARK_OFFLINE_SCENARIO === "whitespace-wait") {
			return fauxAssistantMessage([
				fauxToolCall("collaborate", {
					action: { name: "claim", work: "organize the initial work" },
				}, { id: "offline-whitespace-claim" }),
				fauxToolCall("collaborate", {
					action: { name: "delegate", goal_id: runId, focus: "inspect the issue boundary" },
				}, { id: "offline-whitespace-delegate" }),
				fauxToolCall("collaborate", {
					action: { name: "wait", execution_id: "   " },
				}, { id: "offline-whitespace-wait" }),
			]);
		}
		if (process.env.CODEMARK_OFFLINE_SCENARIO === "invalid-first-wait") {
			return fauxAssistantMessage([
				fauxToolCall("definitely-unknown", {}, { id: "offline-unknown-before-wait" }),
				fauxToolCall("collaborate", {
					action: { name: "claim" },
				}, { id: "offline-invalid-before-wait" }),
				fauxToolCall("collaborate", {
					action: { name: "claim", work: "organize the initial work" },
				}, { id: "offline-invalid-claim" }),
				fauxToolCall("collaborate", {
					action: { name: "delegate", goal_id: runId, focus: "inspect the issue boundary" },
				}, { id: "offline-invalid-delegate" }),
				fauxToolCall("collaborate", {
					action: { name: "wait", unexpected: true },
				}, { id: "offline-invalid-first-wait" }),
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
			fauxToolCall("collaborate", {
				action: { name: "wait" },
			}, { id: "offline-wait" }),
			fauxToolCall("collaborate", {
				action: { name: "delegate", goal_id: runId, focus: "must be ignored after wait" },
			}, { id: "offline-delegate-after-wait" }),
			fauxToolCall("collaborate", {
				action: { name: "wait", unexpected: true },
			}, { id: "offline-second-wait" }),
		]);
	},
	(context) => {
		if (process.env.CODEMARK_OFFLINE_SCENARIO !== "identity-probe") {
			throw new Error("unexpected second Manager call");
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
			fauxToolCall("collaborate", {
				action: { name: "wait" },
			}, { id: "offline-identity-wait" }),
		]);
	},
]);

export default function (pi: ExtensionAPI): void {
	pi.registerProvider(provider.provider);
}
