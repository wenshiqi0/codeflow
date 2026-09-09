/** Assemble a fresh, Goal-scoped working set for every Commitment. */

import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canonicalJson } from "../../lib/canonical";
import { loadCommitment, loadTerminalReceipt, recordRuntimeFailure } from "../../lib/commitment";
import { recordExecutionFailure } from "../../lib/executions";
import { CONTEXT_PRESSURE_THRESHOLDS, deliverEvent } from "../../lib/events";
import { CONTEXT_BUDGET_ABORT_MARKER } from "../../lib/runtime-signals";
import {
	appendRunFactsRecord,
	RUN_FACTS_SCHEMA_VERSION,
	type ContextUtilization,
} from "../../lib/observability/run-facts";
import { canonicalShape, textShape, type ToolSchemaShape, type WorkerContextShape } from "../../lib/observability/prompt-shape";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";
import { buildWorkerContext } from "./context";

const CONTEXT_CUSTOM_TYPE = "codeflow:context";
const RUN_FACTS_CUSTOM_TYPE = "codeflow:run_facts";
const RUN_FACT_THRESHOLDS = [0.5, 0.7] as const;
export const AGENT_CONTEXT_STOP_UTILIZATION = 0.8;
export const CONTEXT_BUDGET_INTERRUPTED_SUMMARY =
	"Execution context reached 80% utilization; resume the same open Commitment with fresh context to reconcile unfinished work.";

function readIfPresent(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

function reportContextBudgetLimit(paths: RunPaths, goalId: string, executionId: string, commitmentId?: string): void {
	if (commitmentId) {
		if (loadTerminalReceipt(paths, commitmentId)) return;
		// Context exhaustion is a Runtime interruption, not the Agent's semantic
		// blocker. Keep the original Commitment open for exact stopped-attempt resume.
		recordRuntimeFailure(paths, commitmentId, ["CONTEXT_BUDGET_EXCEEDED"], CONTEXT_BUDGET_INTERRUPTED_SUMMARY);
		return;
	}
	recordExecutionFailure(paths, executionId, goalId, ["CONTEXT_BUDGET_EXCEEDED"], CONTEXT_BUDGET_INTERRUPTED_SUMMARY);
}

export default function (pi: ExtensionAPI) {
	let executionRoundsElapsed = 0;
	let previousMessagePrefix: string | null = null;
	let previousSystemPromptHash: string | null = null;
	let previousToolSchemaHash: string | null = null;
	let previousWorkerContextHash: string | null = null;
	let workerContextShape: WorkerContextShape | null = null;
	let notifiedThresholdIndex = -1;
	let emittedPressureThresholdIndex = -1;
	let contextBudgetStopTriggered = false;

	pi.on("before_agent_start", (event) => {
		const taskId = process.env.CODEFLOW_RUN_ID;
		const goalId = process.env.CODEFLOW_GOAL_ID;
		const commitmentId = process.env.CODEFLOW_COMMITMENT_ID;
		if (!taskId || !goalId) throw new Error("Codeflow agent requires a Task and Goal");
		const paths = new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, taskId);
		const current = commitmentId ? loadCommitment(paths, commitmentId) : null;
		const cwd = event.systemPromptOptions?.cwd || process.cwd();
		const block = buildWorkerContext(paths, goalId, current, {
			projectRules: readIfPresent(path.join(cwd, "AGENTS.md")),
			workFocus: process.env.CODEFLOW_WORK_FOCUS,
		});
		workerContextShape = block.shape;
		return {
			message: {
				customType: CONTEXT_CUSTOM_TYPE,
				content: block.xml,
				display: true,
				details: { sources: block.sources, shape: block.shape },
			},
		};
	});

	pi.on("message_end", (event) => {
		if ((event.message as { role?: unknown }).role === "assistant") executionRoundsElapsed++;
	});

	pi.on("context", (event, ctx) => {
		const taskId = process.env.CODEFLOW_RUN_ID;
		const commitmentId = process.env.CODEFLOW_COMMITMENT_ID;
		const goalId = process.env.CODEFLOW_GOAL_ID;
		const executionId = process.env.CODEFLOW_EXECUTION_ID;
		if (!taskId || !goalId || !executionId) throw new Error("Codeflow agent requires run fact attribution");
		const paths = new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, taskId);
		const messages = event.messages.filter(
			(message) => (message as { customType?: string }).customType !== RUN_FACTS_CUSTOM_TYPE,
		);
		if (!workerContextShape) throw new Error("Codeflow agent context shape is unavailable before provider request");
		const systemPromptShape = textShape(ctx.getSystemPrompt());
		const activeToolNames = new Set(pi.getActiveTools());
		const activeTools = pi.getAllTools()
			.filter((tool) => activeToolNames.has(tool.name))
			.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
		const rawToolShape = canonicalShape(activeTools);
		const toolSchemaShape: ToolSchemaShape = { ...rawToolShape, count: activeTools.length };
		const usage = ctx.getContextUsage();
		const measurement = usage && usage.tokens !== null && Number.isFinite(usage.tokens) && usage.tokens >= 0
			&& Number.isFinite(usage.contextWindow) && usage.contextWindow > 0 && Number.isFinite(usage.tokens / usage.contextWindow)
			? { tokens: usage.tokens, context_window: usage.contextWindow, utilization: usage.tokens / usage.contextWindow }
			: undefined;
		const contextUtilization: ContextUtilization =
			measurement
				? { value: measurement.utilization, basis: "pi_estimate" }
				: { basis: "unknown" };
		const facts = {
			execution_rounds_elapsed: executionRoundsElapsed,
			context_utilization: contextUtilization,
		};
		const thresholdIndex = contextUtilization.basis === "pi_estimate"
			? RUN_FACT_THRESHOLDS.findLastIndex((threshold) => contextUtilization.value >= threshold)
			: -1;
		const shouldNotify = thresholdIndex > notifiedThresholdIndex;
		if (shouldNotify) notifiedThresholdIndex = thresholdIndex;
		const providerMessages = shouldNotify
			? [
				...messages,
				{
					role: "user",
					content: `<run_facts>${canonicalJson(facts)}</run_facts>`,
					timestamp: Date.now(),
					customType: RUN_FACTS_CUSTOM_TYPE,
				} as (typeof event.messages)[number],
			]
			: messages;
		const messagePrefix = providerMessages.map((message) => canonicalJson(message)).join("\n") + "\n";
		const transition = previousMessagePrefix === null ? 0 : 1;
		const systemPromptChanged = previousSystemPromptHash !== null && previousSystemPromptHash !== systemPromptShape.hash ? 1 : 0;
		const toolSchemaChanged = previousToolSchemaHash !== null && previousToolSchemaHash !== toolSchemaShape.hash ? 1 : 0;
		const workerContextChanged = previousWorkerContextHash !== null && previousWorkerContextHash !== workerContextShape.hash ? 1 : 0;
		const messagePrefixInvalidated = previousMessagePrefix !== null && !messagePrefix.startsWith(previousMessagePrefix) ? 1 : 0;
		const invalidation = transition === 1
			&& (systemPromptChanged || toolSchemaChanged || workerContextChanged || messagePrefixInvalidated) ? 1 : 0;
		previousMessagePrefix = messagePrefix;
		previousSystemPromptHash = systemPromptShape.hash;
		previousToolSchemaHash = toolSchemaShape.hash;
		previousWorkerContextHash = workerContextShape.hash;
		const promptShape = {
			system_prompt: systemPromptShape,
			tool_schema: toolSchemaShape,
			worker_context: workerContextShape,
			message_prefix: textShape(messagePrefix),
		};
		appendRunFactsRecord(
			paths,
			{
				schema_version: RUN_FACTS_SCHEMA_VERSION,
				task_id: taskId,
				execution_id: executionId,
				commitment_id: commitmentId ?? null,
				goal_id: goalId,
				...facts,
				prompt_shape: promptShape,
				prefix_transition_count: transition,
				prefix_invalidation_count: invalidation,
				system_prompt_changed: systemPromptChanged,
				tool_schema_changed: toolSchemaChanged,
				worker_context_changed: workerContextChanged,
				message_prefix_invalidated: messagePrefixInvalidated,
			},
		);
		const pressureThresholdIndex = measurement
			? CONTEXT_PRESSURE_THRESHOLDS.findLastIndex(threshold => measurement.utilization >= threshold)
			: -1;
		if (measurement && pressureThresholdIndex > emittedPressureThresholdIndex) {
			const threshold = CONTEXT_PRESSURE_THRESHOLDS[pressureThresholdIndex];
			const agentId = process.env.CODEFLOW_TEAM_AGENT_ID;
			deliverEvent({
				stagingDir: paths.tmp, targetDir: paths.events, counterPath: paths.eventSeq,
				subject: executionId, kind: "context_pressure", status: "UPDATED",
				payload: {
					task_id: taskId, goal_id: goalId, execution_id: executionId,
					...(agentId ? { agent_id: agentId } : {}), ...(commitmentId ? { commitment_id: commitmentId } : {}),
					context_pressure: { basis: "pi_estimate", threshold, ...measurement },
					summary: `Context utilization is ${(measurement.utilization * 100).toFixed(1)}% (Pi estimate); reached the ${threshold * 100}% threshold.`,
				},
			});
			emittedPressureThresholdIndex = pressureThresholdIndex;
		}
		const shouldStopForContextBudget = !contextBudgetStopTriggered
			&& contextUtilization.basis === "pi_estimate"
			&& contextUtilization.value >= AGENT_CONTEXT_STOP_UTILIZATION;
		if (shouldStopForContextBudget) {
				contextBudgetStopTriggered = true;
				reportContextBudgetLimit(paths, goalId, executionId, commitmentId);
				console.error(`${CONTEXT_BUDGET_ABORT_MARKER}: ${CONTEXT_BUDGET_INTERRUPTED_SUMMARY}`);
				// Print/JSON mode does not bind graceful shutdown, so abort the active
				// turn as well. The durable Runtime event is written before either call.
			ctx.abort();
			ctx.shutdown();
		}
		return { messages: providerMessages };
	});

	// A Commitment must close with a Receipt or be re-grounded from durable state.
	// Silent conversation compaction would create an untracked continuation state.
	pi.on("session_before_compact", () => ({ cancel: true }));
}
