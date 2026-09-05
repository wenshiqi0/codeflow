#!/usr/bin/env bun
/** Real Pi bootstrap + deterministic provider. No production launch/feedback mocks. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { commitmentHistory, loadCommitment, loadTerminalReceipt } from "../../../runtime/lib/commitment";
import { RunPaths } from "../../../runtime/lib/paths";

const fixtureFile = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(fixtureFile), "../../..");

if (import.meta.main) {
	// Production spawnWorker restarts process.argv[1]. Keeping this bootstrap as
	// that entrypoint guarantees every descendant uses the same offline provider.
	// Only Pi's test state directory and session persistence differ from production.
	process.env.PI_CODING_AGENT_DIR = path.join(process.env.CODEFLOW_RECURSIVE_TEST_DIR!, "pi");
	process.argv.push("--extension", fixtureFile, "--no-session");
	await import(path.join(repository, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"));
}

export default function recursiveAgent(pi: ExtensionAPI): void {
	const testDir = process.env.CODEFLOW_RECURSIVE_TEST_DIR!;
	const paths = new RunPaths(process.env.CODEFLOW_RUNS_DIR!, process.env.CODEFLOW_RUN_ID!);
	let parentId = process.env.CODEFLOW_PARENT_COMMITMENT_ID;
	let depth = 0;
	while (parentId) {
		depth += 1;
		parentId = loadCommitment(paths, parentId).parent_commitment_id ?? undefined;
	}
	const traceFile = path.join(testDir, `depth-${depth}.jsonl`);
	const trace = (kind: string, extra: Record<string, unknown> = {}) => {
		fs.appendFileSync(traceFile, `${JSON.stringify({
			kind, depth, pid: process.pid, at: Date.now(),
			execution_id: process.env.CODEFLOW_EXECUTION_ID,
			commitment_id: process.env.CODEFLOW_COMMITMENT_ID ?? null,
			...extra,
		})}\n`);
	};
	let delegated = false;
	let childExecutionId: string | undefined;
	let calls = 0;
	const maximumDepth = 3;

	function observedChildEnd(context: Context): boolean {
		for (const message of context.messages) {
			// Pi projects Runtime custom messages to user text for the provider.
			if (message.role !== "user") continue;
			const texts = typeof message.content === "string" ? [message.content]
				: message.content.flatMap((item) => item.type === "text" ? [item.text] : []);
			for (const content of texts) {
				try {
					const value = JSON.parse(content) as { updates?: Array<Record<string, unknown>> };
					if (value.updates?.some((update) => update.execution_id === childExecutionId
						&& update.status === "completed" && update.exit_code === 0)) return true;
				} catch { /* Ignore unrelated user messages. */ }
			}
		}
		return false;
	}

	const provider = fauxProvider({
		api: "codeflow-recursive-offline-api",
		provider: "codeflow-recursive-offline",
		models: [{ id: "agent", name: "Offline Recursive Agent", reasoning: false,
			input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000, maxTokens: 4_096 }],
	});
	provider.setResponses(Array.from({ length: 30 }, () => async (context, options) => {
		calls += 1;
		trace("provider_call", { calls });
		const commitmentId = process.env.CODEFLOW_COMMITMENT_ID;
		if (!commitmentId) return fauxAssistantMessage([fauxToolCall("collaborate", {
			action: { name: "claim", work: `Own independently bounded recursive work at depth ${depth}` },
		})]);
		if (depth < maximumDepth && !delegated) {
			delegated = true;
			const existingChild = commitmentHistory(paths).find((view) =>
				view.commitment.parent_commitment_id === commitmentId && view.folded.terminal === null);
			return fauxAssistantMessage([fauxToolCall("collaborate", {
				action: {
					name: "delegate", goal_id: paths.runId, focus: `Independent nested work at depth ${depth + 1}`,
					...(existingChild ? { resume_commitment_id: existingChild.commitment.id } : {}),
				},
			})]);
		}
		if (loadTerminalReceipt(paths, commitmentId)) {
			return fauxAssistantMessage([{ type: "text", text: `Depth ${depth} is complete.` }]);
		}
		if (depth === maximumDepth) {
			trace("leaf_waiting");
			await new Promise<void>((resolve) => {
				const poll = setInterval(() => {
					if (!fs.existsSync(path.join(testDir, "release-leaf")) && !options?.signal?.aborted) return;
					clearInterval(poll);
					resolve();
				}, 20);
			});
			if (options?.signal?.aborted) {
				trace("leaf_aborted");
				return fauxAssistantMessage([], { stopReason: "aborted" });
			}
		} else if (!observedChildEnd(context)) {
			trace("parent_idle", { calls });
			return fauxAssistantMessage([{ type: "text", text: "Useful independent work is in progress." }]);
		} else {
			trace("child_end_received", { child_execution_id: childExecutionId });
		}
		return fauxAssistantMessage([fauxToolCall("collaborate", {
			action: { name: "report", status: "completed", summary: `Reconciled all delegated work at depth ${depth}` },
		})]);
	}));
	pi.registerProvider(provider.provider);
	trace("registered", {
		process_kind: process.env.CODEFLOW_PROCESS_KIND,
		model: process.env.CODEFLOW_AGENT_MODEL,
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== "collaborate") return;
		const action = (event.input as { action?: { name?: string } }).action?.name;
		const resultText = event.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
		trace("tool_result", { action, is_error: event.isError, result: resultText });
		if (action === "delegate" && !event.isError) {
			try { childExecutionId = JSON.parse(resultText).execution_id; } catch { /* Trace exposes malformed output. */ }
		}
	});
	pi.on("agent_end", () => { trace("agent_end", { calls }); });
	pi.on("session_shutdown", () => { trace("session_shutdown", { calls }); });
}
