/**
 * Benchmark instrumentation (real mode): append attributed model usage,
 * privacy-safe tool-call rows, and failed provider attempts to the benchmark
 * driver's staging ledger.
 *
 * Inert unless CODEFLOW_BENCHMARK_DRIVER_LEDGER_DIR is set — normal runs load
 * this extension and it does nothing. The benchmark driver script
 * (benchmark/scripts/codeflow-driver.ts) sets the variable for every
 * worker process of the attempt's Codeflow run (root and delegated
 * children alike, via inherited env), so rounds are attributed by
 * role/provider/model/goal-thread exactly as the run's own usage ledger does
 * (design §6/§14: reuse the existing usage/attribution machinery — one
 * assistant usage record is one model round, no transcript parsing).
 *
 * Tool-call rows carry DIRECT provider/model attribution from the context
 * that EMITTED the call: the assistant response whose tool_call event fired
 * (the same provider/model the usage/failed-attempt ledgers record for that
 * response). The emitting context is remembered per call id at request time,
 * so a late tool_execution_end row keeps the original model even after the
 * role switched models mid-attempt; a call with no prior assistant context
 * still records non-empty attribution ("unknown"), never an empty row.
 *
 * Ledger rows are written through the benchmark module's own validators
 * (appendAttemptUsageRecord / appendToolCallRecord), so the privacy boundary
 * (id/name/status/timestamps/attribution only; cache zero-vs-unreported
 * preserved) is enforced at write time, not by convention.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { appendToolCallRecord, type ToolCallRecord } from "../../lib/observability/tool-execution";
import { appendAttemptUsageRecord, type AttemptUsageRecord } from "../../lib/observability/model-usage";

const LEDGER_DIR_ENV = "CODEFLOW_BENCHMARK_DRIVER_LEDGER_DIR";

function env(name: string): string | undefined {
	const value = process.env[name];
	return value === "" ? undefined : value;
}

function optionalEnv(name: string): string | null {
	return env(name) ?? null;
}

/** Bounded machine token (e.g. "provider_timeout"); never message prose. */
function errorClassToken(value: unknown): string {
	return (
		String(value ?? "provider_error")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 40) || "provider_error"
	);
}

/** Explicit 0 is data; absent means the provider did not report. */
function cacheNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function plainNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
	return (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
}

function commandText(input: unknown): string {
	const command = asRecord(input).command;
	return typeof command === "string" ? command : "";
}

function operationKind(tool: string, input: unknown): ToolCallRecord["operation_kind"] {
	if (tool === "edit" || tool === "write") return "edit";
	if (tool === "task" || tool === "goal" || tool === "task_group") return "ceremony";
	if (tool === "read") return "explore";
	if (tool !== "bash") return "other";

	const command = commandText(input);
	if (/^code-agent\s+goal\s+list(?:\s|$)/.test(command)) return "goal_list";
	if (/^code-agent\s+goal\s+show(?:\s|$)/.test(command)) return "goal_show";
	if (/^code-agent\s+handoff\s+index(?:\s|$)/.test(command)) return "handoff_index";
	if (/^code-agent\s+handoff\s+(?:get|body|receipt)(?:\s|$)/.test(command)) {
		return "handoff_recall";
	}
	if (/^code-agent\s+evidence\s+log(?:\s|$)/.test(command)) return "evidence_log";
	if (/^code-agent\s+evidence\s+run(?:\s|$)/.test(command)) return "evidence_run";
	if (/(^|\s)(?:pytest|py\.test|bun|npm|pnpm|yarn|go|cargo|make)(?:\s|$)/.test(command)) {
		return "execute";
	}
	if (/(^|\s)(?:git|grep|rg|find|fd|ls|cat|head|tail|sed|awk)(?:\s|$)/.test(command)) {
		return "explore";
	}
	return "other";
}

/** Direct provider/model attribution of one assistant response. */
interface EmittingContext {
	provider: string;
	model: string;
}

/** Attribution fallback when no assistant response was observed yet — the row
 * must stay countable and attributable, never empty. */
const UNKNOWN_CONTEXT: EmittingContext = { provider: "unknown", model: "unknown" };

export default function (pi: ExtensionAPI): void {
	const ledgerDir = env(LEDGER_DIR_ENV);
	if (ledgerDir === undefined) return; // not a benchmark attempt — inert
	const ledger: string = ledgerDir;

	const attempt = Number(env("CODEFLOW_BENCHMARK_ATTEMPT") ?? "1") || 1;
	const usageFile = path.join(ledger, "usage.jsonl");
	const toolFile = path.join(ledger, "tool-calls.jsonl");
	const failedFile = path.join(ledger, "failed-model-attempts.jsonl");

	function appendRow(file: string, row: Record<string, unknown>): void {
		fs.mkdirSync(ledger, { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
	}

	function attributedRow(
		at: string,
		emitting: EmittingContext,
	): Pick<
		ToolCallRecord,
		"at" | "run_id" | "role" | "depth" | "handoff_id" | "goal_id" | "thread" | "provider" | "model"
	> {
		return {
			at,
			run_id: env("CODEFLOW_RUN_ID") ?? null,
			role: env("CODEFLOW_AGENT_ROLE") ?? "unknown",
			depth: Number(env("CODEFLOW_AGENT_DEPTH") ?? "0") || 0,
			handoff_id: optionalEnv("CODEFLOW_HANDOFF_ID"),
			goal_id: optionalEnv("CODEFLOW_GOAL_ID"),
			thread: optionalEnv("CODEFLOW_THREAD"),
			provider: emitting.provider,
			model: emitting.model,
		};
	}

	/** The assistant response that most recently emitted in this role process. */
	let lastEmitting: EmittingContext = UNKNOWN_CONTEXT;
	/** call_id -> the context that EMITTED that call (result rows keep it). */
	const callEmitting = new Map<string, EmittingContext>();
	const callOperations = new Map<string, ToolCallRecord["operation_kind"]>();
	/** 1-based turn attribution when Pi emitted a turn_start event. */
	let currentTurn: number | null = null;

	pi.on("turn_start", (event) => {
		const turn = Number((event as { turnIndex?: unknown }).turnIndex);
		if (Number.isInteger(turn) && turn >= 0) currentTurn = turn + 1;
	});

	pi.on("message_end", (event) => {
		const message = asRecord(event.message);
		if (message.role !== "assistant") return;
		const rawUsage = asRecord(message.usage);
		const hasUsage = typeof event.message === "object" && event.message !== null && "usage" in message;
		const timestamp = plainNumber(message.timestamp);
		const at = timestamp > 0 ? new Date(timestamp).toISOString() : new Date().toISOString();
		const role = env("CODEFLOW_AGENT_ROLE") ?? "unknown";
		const provider = String(message.provider ?? "") || "unknown";
		const model = String(message.responseModel ?? message.model ?? "") || "unknown";
		// This assistant response IS the emitting context for the tool calls it
		// carries — with usage or not, the attribution is the response's own.
		lastEmitting = { provider, model };

		if (!hasUsage) {
			// A provider request that produced no assistant response with
			// usage is a failed model attempt, never a completed round.
			appendRow(failedFile, {
				schema_version: 1,
				at,
				role,
				provider,
				model,
				error_class: errorClassToken(message.stopReason ?? message.errorMessage ?? "provider_error"),
			});
			return;
		}

		const cacheRead = cacheNumber(rawUsage.cacheRead ?? rawUsage.cache_read);
		const cacheWrite = cacheNumber(rawUsage.cacheWrite ?? rawUsage.cache_write);
		const input = plainNumber(rawUsage.input);
		const output = plainNumber(rawUsage.output);
		const reportedTotal = rawUsage.totalTokens ?? rawUsage.total_tokens;
		// Provider-reported total is a consumption metric; when a provider
		// omits it, the sum of reported components is the honest stand-in.
		const total =
			typeof reportedTotal === "number" && Number.isFinite(reportedTotal)
				? reportedTotal
				: input + output + (cacheRead ?? 0) + (cacheWrite ?? 0);
		const rawCost = asRecord(rawUsage.cost);

		const record: AttemptUsageRecord = {
			schema_version: 2,
			at,
			request_started_at: null,
			attempt,
			run_id: optionalEnv("CODEFLOW_RUN_ID"),
			role,
			provider,
			model,
			depth: Number(env("CODEFLOW_AGENT_DEPTH") ?? "0") || 0,
			turn: currentTurn,
			handoff_id: optionalEnv("CODEFLOW_HANDOFF_ID"),
			goal_id: optionalEnv("CODEFLOW_GOAL_ID"),
			thread: optionalEnv("CODEFLOW_THREAD"),
			usage: {
				input,
				output,
				reasoning: plainNumber(rawUsage.reasoning),
				cache_read: cacheRead,
				cache_write: cacheWrite,
				total_tokens: total,
				cost:
					rawUsage.cost !== null && rawUsage.cost !== undefined
						? {
								input: plainNumber(rawCost.input),
								output: plainNumber(rawCost.output),
								cache_read: plainNumber(rawCost.cacheRead ?? rawCost.cache_read),
								cache_write: plainNumber(rawCost.cacheWrite ?? rawCost.cache_write),
								total: plainNumber(rawCost.total),
							}
						: null,
			},
		};
		appendAttemptUsageRecord(usageFile, record);
	});

	pi.on("tool_call", (event) => {
		const emitting = lastEmitting;
		callEmitting.set(event.toolCallId, emitting);
		const operation = operationKind(event.toolName, event.input);
		callOperations.set(event.toolCallId, operation);
		const row: ToolCallRecord = {
			schema_version: 1,
			kind: "requested",
			call_id: event.toolCallId,
			tool: event.toolName,
			status: null,
			...attributedRow(new Date().toISOString(), emitting),
			operation_kind: operation,
		};
		appendToolCallRecord(toolFile, row);
	});

	pi.on("tool_execution_end", (event) => {
		// The result row keeps the attribution of the context that EMITTED the
		// call, even if later responses (or their absence) moved the pointer.
		const emitting = callEmitting.get(event.toolCallId) ?? lastEmitting;
		callEmitting.delete(event.toolCallId);
		const operation = callOperations.get(event.toolCallId) ?? "other";
		callOperations.delete(event.toolCallId);
		const row: ToolCallRecord = {
			schema_version: 1,
			kind: "result",
			call_id: event.toolCallId,
			tool: event.toolName,
			status: event.isError ? "failed" : "succeeded",
			...attributedRow(new Date().toISOString(), emitting),
			operation_kind: operation,
		};
		appendToolCallRecord(toolFile, row);
	});
}
