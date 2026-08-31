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
import { classifyWorkerKind } from "./rounds";
import { summarizeToolCalls } from "../../runtime/lib/observability/tool-execution";
import { summarizeTokenUsage, type AttemptUsageRecord, type TokenUsageSummary } from "../../runtime/lib/observability/model-usage";
import type { ToolCallRecord } from "../../runtime/lib/observability/tool-execution";
import {
	summarizePrefixCache,
	type PrefixCacheMetrics,
	type RunFactsRecord,
} from "../../runtime/lib/observability/run-facts";
import {
	summarizeCommitmentStates,
	type CommitmentObservabilitySummary,
	type CommitmentStateProjection,
} from "../../runtime/lib/observability/commitment-state";
import { summarizeWallBreakdown, type WallBreakdown } from "../../runtime/lib/observability/timing";
import {
	summarizeContextGrowth,
	summarizeWaste,
	type ContextGrowthSummary,
	type WasteSummary,
} from "../../runtime/lib/observability/usage-analysis";

/** A provider request that failed before any assistant response. */
export const FAILED_ATTEMPT_SCHEMA_VERSION = 1;

export interface FailedModelAttempt {
	schema_version: 1;
	/** ISO timestamp. */
	at: string;
	task_id: string | null;
	worker_kind: "worker" | "service";
	provider: string;
	model: string;
	/** Short token, e.g. "provider_timeout"; never message text. */
	error_class: string;
}

export interface AttemptMetricsInput {
	usageRecords: AttemptUsageRecord[];
	failedModelAttempts: FailedModelAttempt[];
	toolCallRecords: ToolCallRecord[];
	commitmentStates?: CommitmentStateProjection[];
	/** True only when a canonical commitment telemetry artifact was produced. */
	commitmentTelemetryAvailable?: boolean;
	runFactsRecords?: RunFactsRecord[];
	timeToFirstPatchSeconds?: number | null;
	wallStartedAtMs?: number | null;
	wallSeconds: number;
	terminatedBy: BudgetName | null;
}

export interface AttemptMetrics {
	/** == usageRecords.length. */
	model_rounds_total: number;
	worker_model_rounds: number;
	service_model_rounds: number;
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
	tool_calls_by_operation: Record<string, number>;
	/** Null when model_rounds_total === 0. */
	tool_calls_per_model_round: number | null;
	tokens: TokenUsageSummary;
	wall_seconds: number;
	terminated_by: BudgetName | null;
	commitments: CommitmentObservabilitySummary;
	wall_breakdown: WallBreakdown;
	time_to_first_patch_seconds: number | null;
	waste: WasteSummary;
	context_growth: ContextGrowthSummary;
	prefix_cache: PrefixCacheMetrics;
}

export function buildAttemptMetrics(input: AttemptMetricsInput): AttemptMetrics {
	const tools = summarizeToolCalls(input.toolCallRecords);
	let worker = 0;
	let service = 0;
	for (const record of input.usageRecords) {
		if (classifyWorkerKind(record.worker_kind) === "service") service++;
		else worker++;
	}
	const rounds = input.usageRecords.length;
	const commitments = summarizeCommitmentStates(
		input.commitmentStates ?? [],
		input.commitmentTelemetryAvailable ?? false,
	);
	const telemetryAvailable = input.commitmentTelemetryAvailable ?? false;
	return {
		model_rounds_total: rounds,
		worker_model_rounds: worker,
		service_model_rounds: service,
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
		tool_calls_by_operation: tools.by_operation,
		tool_calls_per_model_round: rounds > 0 ? tools.total / rounds : null,
		tokens: summarizeTokenUsage(input.usageRecords),
		wall_seconds: input.wallSeconds,
		terminated_by: input.terminatedBy,
		commitments,
		wall_breakdown: summarizeWallBreakdown(
			input.usageRecords,
			input.toolCallRecords,
			input.wallSeconds,
			input.wallStartedAtMs,
		),
		time_to_first_patch_seconds: input.timeToFirstPatchSeconds ?? null,
		waste: summarizeWaste(input.usageRecords, input.commitmentStates ?? [], telemetryAvailable),
		context_growth: summarizeContextGrowth(
			input.usageRecords,
			input.commitmentStates ?? [],
			telemetryAvailable,
		),
		prefix_cache: summarizePrefixCache(input.runFactsRecords ?? []),
	};
}
