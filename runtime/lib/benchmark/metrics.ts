/**
 * Per-attempt metrics (design §6–§8).
 *
 * Model rounds derive from the per-attempt usage ledger row count — one
 * assistant usage row is one completed round — never from session transcripts
 * or model prose. Failed provider attempts are a separate counter. Tool-call
 * counts come from the privacy-safe ledger. A zero round count leaves
 * `tool_calls_per_model_round` null rather than NaN or Infinity.
 */

import type { BudgetName } from "./budgets";
import { classifyModelRole } from "./rounds";
import { summarizeToolCalls } from "./tool-calls";
import { summarizeTokenUsage, type AttemptUsageRecord, type TokenUsageSummary } from "./tokens";
import type { ToolCallRecord } from "./tool-calls";
import {
	summarizeHandoffStates,
	type HandoffObservabilitySummary,
	type HandoffStateProjection,
} from "../observability/handoff-state";
import { summarizeWallBreakdown, type WallBreakdown } from "../observability/timing";
import {
	summarizeContextGrowth,
	summarizeWaste,
	type ContextGrowthSummary,
	type WasteSummary,
} from "../observability/usage-analysis";

/** A provider request that failed before any assistant response. */
export const FAILED_ATTEMPT_SCHEMA_VERSION = 1;

export interface FailedModelAttempt {
	schema_version: 1;
	/** ISO timestamp. */
	at: string;
	role: string;
	provider: string;
	model: string;
	/** Short token, e.g. "provider_timeout"; never message text. */
	error_class: string;
}

export interface AttemptMetricsInput {
	usageRecords: AttemptUsageRecord[];
	failedModelAttempts: FailedModelAttempt[];
	toolCallRecords: ToolCallRecord[];
	handoffStates?: HandoffStateProjection[];
	/** True only when a canonical handoff telemetry artifact was produced. */
	handoffTelemetryAvailable?: boolean;
	timeToFirstPatchSeconds?: number | null;
	wallStartedAtMs?: number | null;
	wallSeconds: number;
	terminatedBy: BudgetName | null;
}

export interface AttemptMetrics {
	/** == usageRecords.length. */
	model_rounds_total: number;
	primary_model_rounds: number;
	support_model_rounds: number;
	failed_model_attempts: number;
	tool_calls_total: number;
	tool_call_counts: {
		requested: number;
		completed: number;
		succeeded: number;
		failed: number;
		rejected: number;
		incomplete: number;
	};
	tool_calls_by_tool: Record<string, number>;
	/** Null when model_rounds_total === 0. */
	tool_calls_per_model_round: number | null;
	tokens: TokenUsageSummary;
	wall_seconds: number;
	terminated_by: BudgetName | null;
	handoffs: HandoffObservabilitySummary;
	wall_breakdown: WallBreakdown;
	time_to_first_patch_seconds: number | null;
	waste: WasteSummary;
	context_growth: ContextGrowthSummary;
}

export function buildAttemptMetrics(input: AttemptMetricsInput): AttemptMetrics {
	const tools = summarizeToolCalls(input.toolCallRecords);
	let primary = 0;
	let support = 0;
	for (const record of input.usageRecords) {
		if (classifyModelRole(record.role) === "support") support++;
		else primary++;
	}
	const rounds = input.usageRecords.length;
	const handoffs = summarizeHandoffStates(
		input.handoffStates ?? [],
		input.handoffTelemetryAvailable ?? false,
	);
	const telemetryAvailable = input.handoffTelemetryAvailable ?? false;
	return {
		model_rounds_total: rounds,
		primary_model_rounds: primary,
		support_model_rounds: support,
		failed_model_attempts: input.failedModelAttempts.length,
		tool_calls_total: tools.total,
		tool_call_counts: {
			requested: tools.requested,
			completed: tools.completed,
			succeeded: tools.succeeded,
			failed: tools.failed,
			rejected: tools.rejected,
			incomplete: tools.incomplete,
		},
		tool_calls_by_tool: tools.by_tool,
		tool_calls_per_model_round: rounds > 0 ? tools.total / rounds : null,
		tokens: summarizeTokenUsage(input.usageRecords),
		wall_seconds: input.wallSeconds,
		terminated_by: input.terminatedBy,
		handoffs,
		wall_breakdown: summarizeWallBreakdown(
			input.usageRecords,
			input.toolCallRecords,
			input.wallSeconds,
			input.wallStartedAtMs,
		),
		time_to_first_patch_seconds: input.timeToFirstPatchSeconds ?? null,
		waste: summarizeWaste(input.usageRecords, input.handoffStates ?? [], telemetryAvailable),
		context_growth: summarizeContextGrowth(
			input.usageRecords,
			input.handoffStates ?? [],
			telemetryAvailable,
		),
	};
}
