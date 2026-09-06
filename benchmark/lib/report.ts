/**
 * report.json aggregation (design §9, §11).
 *
 * Reads <outDir> artifacts only — manifest, case files, predictions — no
 * driver, no evaluator, no model, no network, so `codeflow benchmark report`
 * can rebuild the report deterministically from an existing run.
 *
 * Load-bearing properties:
 * - Correctness gates the report; the resolved-rate denominator is valid
 *   official verdicts only, while infra_error and not_evaluated stay visible
 *   in counts — missing results cannot be hidden by shrinking the denominator.
 * - Per-resolved numerators include every attempt (failed-but-infra-valid
 *   alike), so a configuration cannot win by failing fast. resolved == 0
 *   yields null, never division by zero or Infinity.
 * - The aggregate cache hit rate is token-weighted across attempts and null
 *   unless every contributing attempt had cache metrics available.
 * - No composite score exists; wall time is telemetry, explicitly not_ranked.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalJson } from "../../runtime/lib/canonical";
import { nowIso } from "../../runtime/lib/paths";
import type { BenchmarkManifest, CaseAttemptRecord, CaseFile } from "./artifacts";
import {
	BENCHMARK_MANIFEST_SCHEMA_VERSION,
	OBSERVATION_SCHEMA_VERSION,
	} from "./artifacts";
import { BENCHMARK_CASE_SCHEMA_VERSION } from "./artifacts";
import { type BudgetName } from "./budgets";
import { readPredictions } from "./predictions";
import { readAttemptUsageRecords } from "../../runtime/lib/observability/model-usage";
import { readToolCallRecords } from "../../runtime/lib/observability/tool-execution";
import type { BenchmarkVerdict } from "./driver";
import {
	readCommitmentStateProjections,
	type CommitmentStateProjection,
} from "../../runtime/lib/observability/commitment-state";
import {
	addCommitmentState as accumulateCommitmentState,
	emptyCommitmentObservabilitySummary,
	type CommitmentObservabilitySummary,
} from "../../runtime/lib/observability/summary";
import type { ContextGrowthSummary, WasteSummary } from "../../runtime/lib/observability/usage-analysis";

export const BENCHMARK_REPORT_SCHEMA_VERSION = 5;

export class BenchmarkReportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BenchmarkReportError";
	}
}

export interface BreakdownTotals {
	model_rounds: number;
	tool_calls: number;
	total_tokens: number;
}

export interface BenchmarkReport {
	schema_version: 5;
	execution_method: "single-executor" | "legacy-unspecified";
	outer_orchestration_measurement: false;
	benchmark_run_id: string;
	generated_at: string;
	attempts_per_instance: number;
	not_official: boolean;
	counts: {
		instances: number;
		attempts: number;
		resolved: number;
		unresolved: number;
		infra_error: number;
		not_evaluated: number;
	};
	resolved_rate: number | null;
	resolved_rate_denominator: number;
	resolved: {
		pass_at_1_mean: number | null;
		pass_at_1_stderr: number | null;
		pass_at_n: number | null;
	};
	dispersion: {
		rounds_per_instance_cv_median: number | null;
		tokens_per_instance_cv_median: number | null;
		verdict_flip_rate: number | null;
	} | null;
	budget_terminations: {
		wall_seconds: number;
		none: number;
	};
	patch_hygiene: {
		attempts_with_stripped_binary_patches: number;
		stripped_binary_path_count: number;
		stripped_binary_paths: string[];
	};
	model_rounds: { total: number; median: number; p90: number; worker: number; service: number; failed_attempts: number };
	tool_calls: { total: number; median: number; p90: number };
	tokens: { total: number; median: number; p90: number };
	per_resolved: { rounds: number | null; tool_calls: number | null; tokens: number | null };
	cache: {
		read: number;
		write: number;
		fresh_input_tokens: number;
		fresh_tokens: number | null;
		prompt_tokens: number;
		hit_rate: number | null;
		metrics_available: boolean;
		per_attempt_hit_rate: { median: number | null; p90: number | null };
	};
	prefix_cache: {
		prefix_transition_count: number;
		prefix_invalidation_count: number;
		prefix_invalidation_rate: number | null;
		system_prompt_change_count: number;
		tool_schema_change_count: number;
		worker_context_change_count: number;
		message_prefix_invalidation_count: number;
		prompt_shape_metrics_available: boolean;
		component_chars: {
			system_prompt: number[];
			tool_schema: number[];
			worker_context: number[];
			message_prefix_min: number | null;
			message_prefix_max: number | null;
		};
		max_context_utilization: number | null;
		metrics_available: boolean;
	};
	split_economics: {
		spontaneous_split_eligible: number;
		spontaneous_split_count: number;
		spontaneous_split_rate: number | null;
		rounds_buckets: Record<string, { resolved: number; unresolved: number; resolved_rate: number | null }>;
	};
	observation: BenchmarkManifest["observation"];
	tool_calls_per_model_round: number | null;
	collaboration: {
		source_discovery_operations: number;
		validation_operations: number;
		integration_operations: number;
	};
	breakdowns: {
		by_goal: Record<string, BreakdownTotals>;
		by_model: Record<string, BreakdownTotals>;
		by_worker_kind: Record<string, BreakdownTotals>;
		by_tool: Record<string, number>;
		by_operation: Record<string, number>;
	};
	wall_time: {
		total_seconds: number;
		median_seconds: number;
		p90_seconds: number;
		not_ranked: true;
		tool_execution_seconds: { total: number; median: number | null; p90: number | null };
		provider_wait_derived_seconds: { total: number; median: number | null; p90: number | null };
		local_overhead_derived_seconds: { total: number; median: number | null; p90: number | null };
		time_to_first_patch_seconds: { median: number | null; p90: number | null };
	};
	runtime_observability: {
		commitments: CommitmentObservabilitySummary & {
			by_goal: Record<string, CommitmentObservabilitySummary>;
		};
		waste: WasteSummary;
		context_growth: ContextGrowthSummary;
	};
	comparison_keys: {
		dataset_id: string;
		dataset_split: string;
		dataset_revision: string;
		/** sha256 hex of the sorted selected instance ids joined by "\n". */
		instance_set_digest: string;
		termination_budgets: {
			wall_seconds: number;
		};
		tool_network: string;
		harness_commit: string;
		observation_schema_version: number;
		intervention_flags: BenchmarkManifest["observation"]["intervention_flags"];
	};
}

const VERDICTS: readonly BenchmarkVerdict[] = ["resolved", "unresolved", "infra_error", "not_evaluated"];
const TERMINATION_KEYS: readonly (BudgetName | "none")[] = ["wall_seconds", "none"];

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Nearest-rank p90: sorted[max(0, ceil(0.9 * n) - 1)]. */
function percentile90(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(0.9 * sorted.length) - 1)];
}

function medianOrNull(values: number[]): number | null {
	return values.length > 0 ? median(values) : null;
}

function percentile90OrNull(values: number[]): number | null {
	return values.length > 0 ? percentile90(values) : null;
}

function meanOrNull(values: number[]): number | null {
	return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sampleStderr(values: number[]): number | null {
	if (values.length < 2) return null;
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	const variance =
		values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
	return Math.sqrt(variance / values.length);
}

function coefficientOfVariation(values: number[]): number | null {
	if (values.length < 2) return null;
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	if (mean === 0) return null;
	const variance =
		values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
	return Math.sqrt(variance) / mean;
}

function aggregateWaste(attempts: CaseAttemptRecord[]): WasteSummary {
	const available = attempts.length > 0 && attempts.every((attempt) => attempt.metrics.waste.metrics_available);
	if (!available) {
		return {
			rounds_in_non_completed_commitments: null,
			tokens_in_non_completed_commitments: null,
			non_completed_round_ratio: null,
			worker_rounds_ratio: null,
			commitments_per_goal_median: null,
			metrics_available: false,
		};
	}
	const nonCompletedRounds = attempts.reduce(
		(sum, attempt) => sum + (attempt.metrics.waste.rounds_in_non_completed_commitments ?? 0),
		0,
	);
	const nonCompletedTokens = attempts.reduce(
		(sum, attempt) => sum + (attempt.metrics.waste.tokens_in_non_completed_commitments ?? 0),
		0,
	);
	const workerWeighted = attempts.filter((attempt) => attempt.metrics.waste.worker_rounds_ratio !== null);
	const workerDenominator = workerWeighted.reduce(
		(sum, attempt) => sum + attempt.metrics.model_rounds_total,
		0,
	);
	const totalRounds = attempts.reduce((sum, attempt) => sum + attempt.metrics.model_rounds_total, 0);
	const commitmentsPerGoal = attempts
		.map((attempt) => attempt.metrics.waste.commitments_per_goal_median)
		.filter((value): value is number => value !== null);
	return {
		rounds_in_non_completed_commitments: nonCompletedRounds,
		tokens_in_non_completed_commitments: nonCompletedTokens,
		non_completed_round_ratio: totalRounds > 0 ? nonCompletedRounds / totalRounds : null,
		worker_rounds_ratio:
			workerDenominator > 0
				? workerWeighted.reduce(
						(sum, attempt) => sum + attempt.metrics.model_rounds_total * (attempt.metrics.waste.worker_rounds_ratio ?? 0),
						0,
					) / workerDenominator
				: null,
		commitments_per_goal_median: medianOrNull(commitmentsPerGoal),
		metrics_available: true,
	};
}

function aggregateContextGrowth(attempts: CaseAttemptRecord[]): ContextGrowthSummary {
	const available =
		attempts.length > 0 && attempts.every((attempt) => attempt.metrics.context_growth.metrics_available);
	if (!available) return { first_turn_input_by_commitment_index: null, metrics_available: false };
	const sequences = attempts
		.map((attempt) => attempt.metrics.context_growth.first_turn_input_by_commitment_index)
		.filter((value): value is number[] => value !== null);
	if (sequences.length === 0) return { first_turn_input_by_commitment_index: null, metrics_available: false };
	const maxLength = Math.max(...sequences.map((values) => values.length));
	const sequence: number[] = [];
	for (let index = 0; index < maxLength; index++) {
		const values = sequences.map((entries) => entries[index]).filter((value) => value !== undefined);
		const value = medianOrNull(values);
		if (value === null) {
			return { first_turn_input_by_commitment_index: null, metrics_available: false };
		}
		sequence.push(value);
	}
	return { first_turn_input_by_commitment_index: sequence, metrics_available: true };
}

function emptyTotals(): BreakdownTotals {
	return { model_rounds: 0, tool_calls: 0, total_tokens: 0 };
}

function bump(map: Record<string, BreakdownTotals>, key: string): BreakdownTotals {
	const existing = map[key];
	if (existing === undefined) {
		const created = emptyTotals();
		map[key] = created;
		return created;
	}
	return existing;
}

function readManifest(outDir: string): BenchmarkManifest {
	const file = path.join(outDir, "benchmark-run.json");
	if (!fs.existsSync(file)) {
		throw new BenchmarkReportError(`not a benchmark run directory (missing benchmark-run.json): ${outDir}`);
	}
	const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as BenchmarkManifest;
	if (parsed.schema_version !== BENCHMARK_MANIFEST_SCHEMA_VERSION) {
		throw new BenchmarkReportError(`unsupported manifest schema_version: ${String(parsed.schema_version)}`);
	}
	return parsed;
}

function readCases(outDir: string): CaseFile[] {
	const casesRoot = path.join(outDir, "cases");
	if (!fs.existsSync(casesRoot)) return [];
	const cases: CaseFile[] = [];
	for (const entry of fs.readdirSync(casesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory()) continue;
		const file = path.join(casesRoot, entry.name, "case.json");
		if (!fs.existsSync(file)) {
			throw new BenchmarkReportError(`case directory without case.json: ${file}`);
		}
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as CaseFile;
		if (parsed.schema_version !== BENCHMARK_CASE_SCHEMA_VERSION) {
			throw new BenchmarkReportError(
				`unsupported case schema_version in ${file}: ${String(parsed.schema_version)}`,
			);
		}
		for (const verdict of [parsed.final_verdict, ...parsed.attempts.map((a) => a.verdict)]) {
			if (!VERDICTS.includes(verdict)) {
				throw new BenchmarkReportError(`invalid verdict in ${file}: ${String(verdict)}`);
			}
		}
		for (const attempt of parsed.attempts) {
			const terminated = attempt.terminated_by ?? "none";
			if (!TERMINATION_KEYS.includes(terminated)) {
				throw new BenchmarkReportError(`invalid terminated_by in ${file}: ${String(attempt.terminated_by)}`);
			}
			if (!attempt.metrics?.commitments || !attempt.metrics.wall_breakdown || !attempt.metrics.waste || !attempt.metrics.context_growth || !attempt.metrics.prefix_cache) {
				throw new BenchmarkReportError(`incomplete current-schema metrics in ${file}`);
			}
			if (attempt.observation?.schema_version !== OBSERVATION_SCHEMA_VERSION) {
				throw new BenchmarkReportError(`incompatible observation schema in ${file}`);
			}
		}
		cases.push(parsed);
	}
	return cases;
}

interface LedgerBreakdownInput {
	byGoal: Record<string, BreakdownTotals>;
	byModel: Record<string, BreakdownTotals>;
	byWorkerKind: Record<string, BreakdownTotals>;
}

/**
 * Goal/model/Worker-kind breakdowns come from the per-attempt ledgers under
 * `cases/` when present (hand-built report fixtures without ledgers simply
 * produce empty breakdowns).
 *
 * by_model joins two independently attributed ledgers (design §7):
 * - tool_calls are grouped by each requested row's RECORDED provider/model —
 *   never by identity inference, so a Worker that switched models mid-attempt
 *   still gets exact per-model counts, and a model with zero rounds can carry
 *   calls (a wall stop can flush a tool row whose usage row was lost);
 * - rounds/tokens are grouped directly from every usage row's provider/model,
 *   including models that emitted zero tools. No dimension silently drops a
 *   zero-round tool call or a zero-tool model round.
 *
 * by_goal and by_worker_kind keep both dimensions from both ledgers.
 */
function accumulateLedgers(outDir: string, cases: CaseFile[], out: LedgerBreakdownInput): void {
	for (const caseFile of cases) {
		const slug = caseFile.instance_id.replace(/\//g, "__");
		for (const attempt of caseFile.attempts) {
			const attemptDir = path.join(outDir, "cases", slug, "attempts", String(attempt.attempt));
			const usageRecords = readAttemptUsageRecords(path.join(attemptDir, "usage.jsonl"));
			const toolRecords = readToolCallRecords(path.join(attemptDir, "tool-calls.jsonl"));

			const callsByModel = new Map<string, number>();
			const callsByGoal = new Map<string, number>();
			const callsByWorkerKind = new Map<string, number>();
			// Tool side first: the recorded attribution decides the model groups
			// without any identity inference.
			for (const record of toolRecords) {
				if (record.kind !== "requested") continue;
				const modelKey = `${record.provider}/${record.model}`;
				callsByModel.set(modelKey, (callsByModel.get(modelKey) ?? 0) + 1);
				const goalKey = record.goal_id ?? record.task_id ?? "unknown";
				callsByGoal.set(goalKey, (callsByGoal.get(goalKey) ?? 0) + 1);
				callsByWorkerKind.set(record.worker_kind, (callsByWorkerKind.get(record.worker_kind) ?? 0) + 1);
			}

			for (const record of usageRecords) {
				const goalKey = record.goal_id ?? record.task_id ?? "unknown";
				bump(out.byGoal, goalKey).model_rounds++;
				out.byGoal[goalKey].total_tokens += record.usage.total_tokens;
				bump(out.byWorkerKind, record.worker_kind).model_rounds++;
				out.byWorkerKind[record.worker_kind].total_tokens += record.usage.total_tokens;
				const modelKey = `${record.provider}/${record.model}`;
				bump(out.byModel, modelKey).model_rounds++;
				out.byModel[modelKey].total_tokens += record.usage.total_tokens;
			}

			// Recorded-field grouping: calls land on the model their rows name.
			for (const [modelKey, count] of callsByModel) {
				bump(out.byModel, modelKey).tool_calls += count;
			}
			for (const [goal, count] of callsByGoal) {
				bump(out.byGoal, goal).tool_calls += count;
			}
			for (const [kind, count] of callsByWorkerKind) {
				bump(out.byWorkerKind, kind).tool_calls += count;
			}
		}
	}
}

function addCommitmentState(
	total: CommitmentObservabilitySummary,
	byGoal: Record<string, CommitmentObservabilitySummary>,
	state: CommitmentStateProjection,
): void {
	total.metrics_available = true;
	accumulateCommitmentState(total, state);

	const goalKey = state.goal_id;
	const goal = byGoal[goalKey] ?? emptyCommitmentObservabilitySummary();
	goal.metrics_available = true;
	byGoal[goalKey] = goal;
	accumulateCommitmentState(goal, state);
}

function accumulateCommitmentObservability(
	outDir: string,
	cases: CaseFile[],
): CommitmentObservabilitySummary & {
	by_goal: Record<string, CommitmentObservabilitySummary>;
} {
	const total = emptyCommitmentObservabilitySummary();
	const byGoal: Record<string, CommitmentObservabilitySummary> = {};
	for (const caseFile of cases) {
		const slug = caseFile.instance_id.replace(/\//g, "__");
		for (const attempt of caseFile.attempts) {
			const file = path.join(outDir, "cases", slug, "attempts", String(attempt.attempt), "telemetry", "commitments.json");
			if (!fs.existsSync(file)) continue;
			total.metrics_available = true;
			for (const state of readCommitmentStateProjections(file)) {
				addCommitmentState(total, byGoal, state);
			}
		}
	}
	return { ...total, by_goal: byGoal };
}

/** Reads <outDir> artifacts only — manifest, case files, predictions. */
export function buildBenchmarkReport(outDir: string): BenchmarkReport {
	const manifest = readManifest(outDir);
	// Validated for contract conformance; a corrupt predictions file must fail
	// loudly instead of masquerading as a complete run.
	const predictions = readPredictions(path.join(outDir, "predictions.jsonl"));
	const cases = readCases(outDir);
	for (const caseFile of cases) {
		for (const attempt of caseFile.attempts) {
			if (canonicalJson(attempt.observation) !== canonicalJson(manifest.observation)) {
				throw new BenchmarkReportError(
					`observation schema or intervention flags differ in ${caseFile.instance_id} attempt ${attempt.attempt}`,
				);
			}
		}
	}
	const selected: string[] = Array.isArray(manifest.instances?.selected) ? manifest.instances.selected : [];
	const uniqueSelected = new Set(selected);
	if (uniqueSelected.size !== selected.length) {
		throw new BenchmarkReportError("manifest instances.selected contains duplicate instance ids");
	}
	const caseIds = cases.map((caseFile) => caseFile.instance_id);
	const uniqueCaseIds = new Set(caseIds);
	if (uniqueCaseIds.size !== caseIds.length) {
		throw new BenchmarkReportError("case artifacts contain duplicate instance ids");
	}
	const missingCases = selected.filter((id) => !uniqueCaseIds.has(id));
	const extraCases = caseIds.filter((id) => !uniqueSelected.has(id));
	if (missingCases.length > 0 || extraCases.length > 0) {
		throw new BenchmarkReportError(
			`case artifacts do not match manifest selection (missing=${missingCases.join(",") || "none"}; ` +
				`extra=${extraCases.join(",") || "none"})`,
		);
	}
	const predictionIds = predictions.map((prediction) => prediction.instance_id);
	if (predictionIds.length !== selected.length || predictionIds.some((id, index) => id !== selected[index])) {
		throw new BenchmarkReportError(
			"predictions.jsonl must contain exactly one entry per selected instance in manifest order",
		);
	}
	const attempts: CaseAttemptRecord[] = cases.flatMap((caseFile) => caseFile.attempts);

	const counts = {
		instances: cases.length,
		attempts: attempts.length,
		resolved: 0,
		unresolved: 0,
		infra_error: 0,
		not_evaluated: 0,
	};
	for (const caseFile of cases) {
		switch (caseFile.final_verdict) {
			case "resolved":
				counts.resolved++;
				break;
			case "unresolved":
				counts.unresolved++;
				break;
			case "infra_error":
				counts.infra_error++;
				break;
			case "not_evaluated":
				counts.not_evaluated++;
				break;
		}
	}
	const denominator = counts.resolved + counts.unresolved;

	const budgetTerminations = {
		wall_seconds: 0,
		none: 0,
	};
	for (const attempt of attempts) {
		budgetTerminations[attempt.terminated_by ?? "none"]++;
	}
	const strippedBinaryPaths = attempts.flatMap(
		(attempt) => attempt.patch_hygiene?.stripped_binary_paths ?? [],
	);

	const roundsPerAttempt = attempts.map((attempt) => attempt.metrics.model_rounds_total);
	const callsPerAttempt = attempts.map((attempt) => attempt.metrics.tool_calls_total);
	const tokensPerAttempt = attempts.map((attempt) => attempt.metrics.tokens.total_tokens);
	const wallPerAttempt = attempts.map((attempt) => attempt.metrics.wall_seconds);

	const roundsTotal = roundsPerAttempt.reduce((sum, value) => sum + value, 0);
	const callsTotal = callsPerAttempt.reduce((sum, value) => sum + value, 0);
	const tokensTotal = tokensPerAttempt.reduce((sum, value) => sum + value, 0);
	const resolved = counts.resolved;

	let cacheRead = 0;
	let cacheWrite = 0;
	let cacheInput = 0;
	let freshTokens = 0;
	let cacheAvailable = attempts.length > 0;
	for (const attempt of attempts) {
		cacheRead += attempt.metrics.tokens.cache_read;
		cacheWrite += attempt.metrics.tokens.cache_write;
		cacheInput += attempt.metrics.tokens.input;
		freshTokens += attempt.metrics.tokens.fresh_tokens ?? 0;
		if (!attempt.metrics.tokens.cache_metrics_available) cacheAvailable = false;
	}
	const cacheDenominator = cacheInput + cacheRead + cacheWrite;
	const perAttemptCacheHitRates = attempts
		.filter((attempt) => attempt.metrics.tokens.cache_metrics_available && attempt.metrics.tokens.cache_hit_rate !== null)
		.map((attempt) => attempt.metrics.tokens.cache_hit_rate as number);

	const byTool: Record<string, number> = {};
	const byOperation: Record<string, number> = {};
	for (const attempt of attempts) {
		for (const [tool, count] of Object.entries(attempt.metrics.tool_calls_by_tool)) {
			byTool[tool] = (byTool[tool] ?? 0) + count;
		}
		for (const [operation, count] of Object.entries(attempt.metrics.tool_calls_by_operation ?? {})) {
			byOperation[operation] = (byOperation[operation] ?? 0) + count;
		}
	}
	const sourceDiscoveryOperations = byOperation.source_discovery ?? 0;
	const validationOperations = ["execute", "evidence_run", "evidence_log"]
		.reduce((sum, kind) => sum + (byOperation[kind] ?? 0), 0);
	const integrationOperations = ["inspect", "claim", "report", "delegate"]
		.reduce((sum, kind) => sum + (byOperation[kind] ?? 0), 0);
	const breakdownInput: LedgerBreakdownInput = {
		byGoal: {},
		byModel: {},
		byWorkerKind: {},
	};
	accumulateLedgers(outDir, cases, breakdownInput);

	const effective = manifest.termination_budgets.effective;
	const commitmentObservability = accumulateCommitmentObservability(outDir, cases);
	const prefixTransitionCount = attempts.reduce(
		(sum, attempt) => sum + attempt.metrics.prefix_cache.prefix_transition_count,
		0,
	);
	const prefixInvalidationCount = attempts.reduce(
		(sum, attempt) => sum + attempt.metrics.prefix_cache.prefix_invalidation_count,
		0,
	);
	const prefixMetricsAvailable = attempts.length > 0
		&& attempts.every((attempt) => attempt.metrics.prefix_cache.metrics_available);
	const promptShapeMetricsAvailable = attempts.length > 0
		&& attempts.every((attempt) => attempt.metrics.prefix_cache.prompt_shape_metrics_available);
	const promptShapeValues = {
		system_prompt: [...new Set(attempts.flatMap((attempt) => attempt.metrics.prefix_cache.component_chars.system_prompt))].sort((left, right) => left - right),
		tool_schema: [...new Set(attempts.flatMap((attempt) => attempt.metrics.prefix_cache.component_chars.tool_schema))].sort((left, right) => left - right),
		worker_context: [...new Set(attempts.flatMap((attempt) => attempt.metrics.prefix_cache.component_chars.worker_context))].sort((left, right) => left - right),
	};
	const messagePrefixMinimums = attempts.flatMap((attempt) => {
		const value = attempt.metrics.prefix_cache.component_chars.message_prefix_min;
		return value === null ? [] : [value];
	});
	const messagePrefixMaximums = attempts.flatMap((attempt) => {
		const value = attempt.metrics.prefix_cache.component_chars.message_prefix_max;
		return value === null ? [] : [value];
	});
	const contextUtilizations = attempts.flatMap((attempt) => {
		const value = attempt.metrics.prefix_cache.max_context_utilization;
		return value === null ? [] : [value];
	});
	const spontaneousEligible = manifest.execution_method === "single-executor" || manifest.observation.request_named_split
		? 0
		: attempts.filter((attempt) => attempt.metrics.commitments.metrics_available).length;
	const spontaneousSplit = manifest.execution_method === "single-executor" || manifest.observation.request_named_split
		? 0
		: attempts.filter((attempt) =>
			attempt.metrics.commitments.metrics_available
			&& attempt.metrics.commitments.delegating > 0).length;
	const roundsBuckets: Record<string, { resolved: number; unresolved: number; resolved_rate: number | null }> = {};
	for (const [label, minimum, maximum] of [
		["0-19", 0, 19],
		["20-39", 20, 39],
		["40+", 40, Number.POSITIVE_INFINITY],
	] as const) {
		const eligible = attempts.filter((attempt) =>
			attempt.metrics.model_rounds_total >= minimum
			&& attempt.metrics.model_rounds_total <= maximum
			&& (attempt.verdict === "resolved" || attempt.verdict === "unresolved"));
		const bucketResolved = eligible.filter((attempt) => attempt.verdict === "resolved").length;
		roundsBuckets[label] = {
			resolved: bucketResolved,
			unresolved: eligible.length - bucketResolved,
			resolved_rate: eligible.length > 0 ? bucketResolved / eligible.length : null,
		};
	}
	const attemptsPerInstance = manifest.attempts_per_instance;
	const validCases = cases
		.map((caseFile) => caseFile.attempts.filter((attempt) => attempt.verdict === "resolved" || attempt.verdict === "unresolved"))
		.filter((attemptList) => attemptList.length > 0);
	const instanceSuccessRates = validCases.map((attemptList) => {
		const resolvedCount = attemptList.filter((attempt) => attempt.verdict === "resolved").length;
		return resolvedCount / attemptList.length;
	});
	const passAtOneMean = meanOrNull(instanceSuccessRates);
	const passAtOneStderr = sampleStderr(instanceSuccessRates);
	const passAtN =
		validCases.length > 0
			? validCases.filter((attemptList) => attemptList.some((attempt) => attempt.verdict === "resolved")).length /
				validCases.length
			: null;
	const dispersion =
		attemptsPerInstance >= 2
			? {
					rounds_per_instance_cv_median: medianOrNull(
						cases
							.map((caseFile) => coefficientOfVariation(caseFile.attempts.map((attempt) => attempt.metrics.model_rounds_total)))
							.filter((value): value is number => value !== null),
					),
					tokens_per_instance_cv_median: medianOrNull(
						cases
							.map((caseFile) => coefficientOfVariation(caseFile.attempts.map((attempt) => attempt.metrics.tokens.total_tokens)))
							.filter((value): value is number => value !== null),
					),
					verdict_flip_rate:
						cases.length > 0
							? cases.filter((caseFile) => new Set(caseFile.attempts.map((attempt) => attempt.verdict)).size > 1).length /
								cases.length
							: null,
				}
			: null;
	const toolExecutionSeconds = attempts.map((attempt) => attempt.metrics.wall_breakdown.tool_execution_seconds);
	const providerWaitSeconds = attempts.map((attempt) => attempt.metrics.wall_breakdown.provider_wait_derived_seconds);
	const localOverheadSeconds = attempts.map((attempt) => attempt.metrics.wall_breakdown.local_overhead_derived_seconds);
	const timeToFirstPatch = attempts
		.map((attempt) => attempt.metrics.time_to_first_patch_seconds)
		.filter((value): value is number => value !== null);
	return {
		schema_version: BENCHMARK_REPORT_SCHEMA_VERSION as 5,
		execution_method: manifest.execution_method ?? "legacy-unspecified",
		outer_orchestration_measurement: false,
		benchmark_run_id: manifest.benchmark_run_id,
		generated_at: nowIso(),
		attempts_per_instance: attemptsPerInstance,
		not_official: attemptsPerInstance > 1,
		counts,
		resolved_rate: denominator > 0 ? resolved / denominator : null,
		resolved_rate_denominator: denominator,
		resolved: {
			pass_at_1_mean: passAtOneMean,
			pass_at_1_stderr: passAtOneStderr,
			pass_at_n: passAtN,
		},
		dispersion,
		budget_terminations: budgetTerminations,
		patch_hygiene: {
			attempts_with_stripped_binary_patches: attempts.filter(
				(attempt) => (attempt.patch_hygiene?.stripped_binary_paths.length ?? 0) > 0,
			).length,
			stripped_binary_path_count: strippedBinaryPaths.length,
			stripped_binary_paths: [...new Set(strippedBinaryPaths)].sort(),
		},
		model_rounds: {
			total: roundsTotal,
			median: median(roundsPerAttempt),
			p90: percentile90(roundsPerAttempt),
			worker: attempts.reduce((sum, a) => sum + a.metrics.worker_model_rounds, 0),
			service: attempts.reduce((sum, a) => sum + a.metrics.service_model_rounds, 0),
			failed_attempts: attempts.reduce((sum, a) => sum + a.metrics.failed_model_attempts, 0),
		},
		tool_calls: { total: callsTotal, median: median(callsPerAttempt), p90: percentile90(callsPerAttempt) },
		tokens: { total: tokensTotal, median: median(tokensPerAttempt), p90: percentile90(tokensPerAttempt) },
		per_resolved: {
			rounds: resolved > 0 ? roundsTotal / resolved : null,
			tool_calls: resolved > 0 ? callsTotal / resolved : null,
			tokens: resolved > 0 ? tokensTotal / resolved : null,
		},
		cache: {
			read: cacheRead,
			write: cacheWrite,
			fresh_input_tokens: cacheInput,
			fresh_tokens: cacheAvailable ? freshTokens : null,
			prompt_tokens: cacheDenominator,
			hit_rate: cacheAvailable && cacheDenominator > 0 ? cacheRead / cacheDenominator : null,
			metrics_available: cacheAvailable,
			per_attempt_hit_rate: {
				median: medianOrNull(perAttemptCacheHitRates),
				p90: percentile90OrNull(perAttemptCacheHitRates),
			},
		},
		prefix_cache: {
			prefix_transition_count: prefixTransitionCount,
			prefix_invalidation_count: prefixInvalidationCount,
			prefix_invalidation_rate: prefixMetricsAvailable && prefixTransitionCount > 0
				? prefixInvalidationCount / prefixTransitionCount
				: null,
			system_prompt_change_count: attempts.reduce(
				(sum, attempt) => sum + attempt.metrics.prefix_cache.system_prompt_change_count,
				0,
			),
			tool_schema_change_count: attempts.reduce(
				(sum, attempt) => sum + attempt.metrics.prefix_cache.tool_schema_change_count,
				0,
			),
			worker_context_change_count: attempts.reduce(
				(sum, attempt) => sum + attempt.metrics.prefix_cache.worker_context_change_count,
				0,
			),
			message_prefix_invalidation_count: attempts.reduce(
				(sum, attempt) => sum + attempt.metrics.prefix_cache.message_prefix_invalidation_count,
				0,
			),
			prompt_shape_metrics_available: promptShapeMetricsAvailable,
			component_chars: {
				...promptShapeValues,
				message_prefix_min: messagePrefixMinimums.length > 0 ? Math.min(...messagePrefixMinimums) : null,
				message_prefix_max: messagePrefixMaximums.length > 0 ? Math.max(...messagePrefixMaximums) : null,
			},
			max_context_utilization: contextUtilizations.length > 0 ? Math.max(...contextUtilizations) : null,
			metrics_available: prefixMetricsAvailable,
		},
		split_economics: {
			spontaneous_split_eligible: spontaneousEligible,
			spontaneous_split_count: spontaneousSplit,
			spontaneous_split_rate: spontaneousEligible > 0 ? spontaneousSplit / spontaneousEligible : null,
			rounds_buckets: roundsBuckets,
		},
		observation: manifest.observation,
		tool_calls_per_model_round: roundsTotal > 0 ? callsTotal / roundsTotal : null,
		collaboration: {
			source_discovery_operations: sourceDiscoveryOperations,
			validation_operations: validationOperations,
			integration_operations: integrationOperations,
		},
		breakdowns: {
			by_goal: breakdownInput.byGoal,
			by_model: breakdownInput.byModel,
			by_worker_kind: breakdownInput.byWorkerKind,
			by_tool: byTool,
			by_operation: byOperation,
		},
		wall_time: {
			total_seconds: wallPerAttempt.reduce((sum, value) => sum + value, 0),
			median_seconds: median(wallPerAttempt),
			p90_seconds: percentile90(wallPerAttempt),
			not_ranked: true,
			tool_execution_seconds: {
				total: toolExecutionSeconds.reduce((sum, value) => sum + value, 0),
				median: medianOrNull(toolExecutionSeconds),
				p90: percentile90OrNull(toolExecutionSeconds),
			},
			provider_wait_derived_seconds: {
				total: providerWaitSeconds.reduce((sum, value) => sum + value, 0),
				median: medianOrNull(providerWaitSeconds),
				p90: percentile90OrNull(providerWaitSeconds),
			},
			local_overhead_derived_seconds: {
				total: localOverheadSeconds.reduce((sum, value) => sum + value, 0),
				median: medianOrNull(localOverheadSeconds),
				p90: percentile90OrNull(localOverheadSeconds),
			},
			time_to_first_patch_seconds: {
				median: medianOrNull(timeToFirstPatch),
				p90: percentile90OrNull(timeToFirstPatch),
			},
		},
		runtime_observability: {
			commitments: commitmentObservability,
			waste: aggregateWaste(attempts),
			context_growth: aggregateContextGrowth(attempts),
		},
		comparison_keys: {
			dataset_id: manifest.dataset.dataset_id,
			dataset_split: manifest.dataset.split,
			dataset_revision: manifest.dataset.revision,
			instance_set_digest: createHash("sha256").update([...selected].sort().join("\n")).digest("hex"),
			termination_budgets: {
				wall_seconds: effective.wall_seconds,
			},
			tool_network: manifest.tool_network,
			harness_commit: manifest.harness.commit,
			observation_schema_version: manifest.observation.schema_version,
			intervention_flags: manifest.observation.intervention_flags,
		},
	};
}
