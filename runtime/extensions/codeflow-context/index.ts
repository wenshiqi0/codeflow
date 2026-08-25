/** Assemble a fresh, Goal-scoped working set for every Handoff. */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canonicalJson } from "../../lib/canonical";
import { loadHandoff } from "../../lib/handoff";
import { appendRunFactsRecord, type ContextUtilization } from "../../lib/observability/run-facts";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";
import { buildWorkerContext } from "./context";

const CONTEXT_CUSTOM_TYPE = "codeflow:context";
const RUN_FACTS_CUSTOM_TYPE = "codeflow:run_facts";
const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readIfPresent(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	let executionRoundsElapsed = 0;
	let previousStablePrefix: string | null = null;

	pi.on("before_agent_start", (event) => {
		const taskId = process.env.CODEFLOW_RUN_ID;
		const handoffId = process.env.CODEFLOW_HANDOFF_ID;
		if (!taskId || !handoffId) throw new Error("Codeflow Worker requires a task and current handoff");
		const paths = new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, taskId);
		const current = loadHandoff(paths, handoffId);
		const cwd = event.systemPromptOptions?.cwd || process.cwd();
		const block = buildWorkerContext(paths, current, {
			sharedRules: readIfPresent(path.join(RUNTIME_DIR, "AGENTS.md")),
			projectRules: readIfPresent(path.join(cwd, "AGENTS.md")),
		});
		return {
			message: {
				customType: CONTEXT_CUSTOM_TYPE,
				content: block.xml,
				display: true,
				details: { sources: block.sources },
			},
		};
	});

	pi.on("message_end", (event) => {
		if ((event.message as { role?: unknown }).role === "assistant") executionRoundsElapsed++;
	});

	pi.on("context", (event, ctx) => {
		const taskId = process.env.CODEFLOW_RUN_ID;
		const handoffId = process.env.CODEFLOW_HANDOFF_ID;
		const goalId = process.env.CODEFLOW_GOAL_ID;
		if (!taskId || !handoffId || !goalId) throw new Error("Codeflow Worker requires run fact attribution");
		const messages = event.messages.filter(
			(message) => (message as { customType?: string }).customType !== RUN_FACTS_CUSTOM_TYPE,
		);
		const stablePrefix = messages.map((message) => canonicalJson(message)).join("\n") + "\n";
		const transition = previousStablePrefix === null ? 0 : 1;
		const invalidation = previousStablePrefix !== null && !stablePrefix.startsWith(previousStablePrefix) ? 1 : 0;
		previousStablePrefix = stablePrefix;
		const usage = ctx.getContextUsage();
		const contextUtilization: ContextUtilization =
			usage && usage.tokens !== null && usage.contextWindow > 0
				? { value: usage.tokens / usage.contextWindow, basis: "pi_estimate" }
				: { basis: "unknown" };
		const facts = {
			execution_rounds_elapsed: executionRoundsElapsed,
			context_utilization: contextUtilization,
		};
		appendRunFactsRecord(
			new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, taskId),
			{
				schema_version: 1,
				task_id: taskId,
				handoff_id: handoffId,
				goal_id: goalId,
				...facts,
				prefix_transition_count: transition,
				prefix_invalidation_count: invalidation,
			},
		);
		return {
			messages: [
				...messages,
				{
					role: "user",
					content: `<run_facts>${canonicalJson(facts)}</run_facts>`,
					timestamp: Date.now(),
					customType: RUN_FACTS_CUSTOM_TYPE,
				} as (typeof event.messages)[number],
			],
		};
	});

	// A Handoff must close with a Receipt or be re-grounded from durable state.
	// Silent conversation compaction would create an untracked continuation state.
	pi.on("session_before_compact", () => ({ cancel: true }));
}
