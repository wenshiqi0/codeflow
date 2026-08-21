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
import { nowIso } from "../paths";
import type { BenchmarkManifest, CaseAttemptRecord, CaseFile } from "./artifacts";
import {
	BENCHMARK_MANIFEST_SCHEMA_VERSION,
	LEGACY_BENCHMARK_MANIFEST_SCHEMA_VERSION,
} from "./artifacts";
import { BENCHMARK_CASE_SCHEMA_VERSION } from "./artifacts";
import { DEFAULT_BENCHMARK_BUDGETS, type BudgetName } from "./budgets";
import { readPredictions } from "./predictions";
import { readAttemptUsageRecords } from "./tokens";
import { readToolCallRecords } from "./tool-calls";
import type { BenchmarkVerdict } from "./driver";
import {
	readHandoffStateProjections,
	type HandoffStateProjection,
} from "../observability/handoff-state";
import {
	emptyHandoffObservabilitySummary,
	type HandoffObservabilitySummary,
} from "../observability/summary";
import type { ContextGrowthSummary, WasteSummary } from "../observability/usage-analysis";

export const BENCHMARK_REPORT_SCHEMA_VERSION = 2;

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
	schema_version: 2;
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
	budget_terminations: { model_rounds: number; tool_calls: number; total_tokens: number; wall_seconds: number; none: number };
	model_rounds: { total: number; median: number; p90: number; primary: number; support: number; failed_attempts: number };
	tool_calls: { total: number; median: number; p90: number };
	tokens: { total: number; median: number; p90: number };
	per_resolved: { rounds: number | null; tool_calls: number | null; tokens: number | null };
	cache: {
		read: number;
		write: number;
		fresh_input_tokens: number;
		prompt_tokens: number;
		hit_rate: number | null;
		metrics_available: boolean;
		per_attempt_hit_rate: { median: number | null; p90: number | null };
	};
	tool_calls_per_model_round: number | null;
	breakdowns: {
		by_role: Record<string, BreakdownTotals>;
		by_model: Record<string, BreakdownTotals>;
		by_lane: Record<string, BreakdownTotals>;
		by_tool: Record<string, number>;
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
		handoffs: HandoffObservabilitySummary & {
			by_role: Record<string, HandoffObservabilitySummary>;
			by_lane: Record<string, HandoffObservabilitySummary>;
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
		budgets: { model_rounds: number; tool_calls: number; total_tokens: number; wall_seconds: number };
		tool_network: string;
		harness_commit: string;
	};
}

const VERDICTS: readonly BenchmarkVerdict[] = ["resolved", "unresolved", "infra_error", "not_evaluated"];
const TERMINATION_KEYS: readonly (BudgetName | "none")[] = [
	"model_rounds",
	"tool_calls",
	"total_tokens",
	"wall_seconds",
	"none",
];

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
			rounds_in_non_pass_handoffs: null,
			tokens_in_non_pass_handoffs: null,
			waste_ratio_rounds: null,
			planner_rounds_ratio: null,
			handoff_reopens_per_goal_lane_median: null,
			metrics_available: false,
		};
	}
	const nonPassRounds = attempts.reduce(
		(sum, attempt) => sum + (attempt.metrics.waste.rounds_in_non_pass_handoffs ?? 0),
		0,
	);
	const nonPassTokens = attempts.reduce(
		(sum, attempt) => sum + (attempt.metrics.waste.tokens_in_non_pass_handoffs ?? 0),
		0,
	);
	const plannerWeighted = attempts.filter((attempt) => attempt.metrics.waste.planner_rounds_ratio !== null);
	const plannerDenominator = plannerWeighted.reduce(
		(sum, attempt) => sum + attempt.metrics.model_rounds_total,
		0,
	);
	const totalRounds = attempts.reduce((sum, attempt) => sum + attempt.metrics.model_rounds_total, 0);
	const reopenValues = attempts
		.map((attempt) => attempt.metrics.waste.handoff_reopens_per_goal_lane_median)
		.filter((value): value is number => value !== null);
	return {
		rounds_in_non_pass_handoffs: nonPassRounds,
		tokens_in_non_pass_handoffs: nonPassTokens,
		waste_ratio_rounds: totalRounds > 0 ? nonPassRounds / totalRounds : null,
		planner_rounds_ratio:
			plannerDenominator > 0
				? plannerWeighted.reduce(
						(sum, attempt) => sum + attempt.metrics.model_rounds_total * (attempt.metrics.waste.planner_rounds_ratio ?? 0),
						0,
					) / plannerDenominator
				: null,
		handoff_reopens_per_goal_lane_median: medianOrNull(reopenValues),
		metrics_available: true,
	};
}

function aggregateContextGrowth(attempts: CaseAttemptRecord[]): ContextGrowthSummary {
	const available =
		attempts.length > 0 && attempts.every((attempt) => attempt.metrics.context_growth.metrics_available);
	if (!available) return { first_turn_input_by_handoff_index: null, metrics_available: false };
	const sequences = attempts
		.map((attempt) => attempt.metrics.context_growth.first_turn_input_by_handoff_index)
		.filter((value): value is number[] => value !== null);
	if (sequences.length === 0) return { first_turn_input_by_handoff_index: null, metrics_available: false };
	const maxLength = Math.max(...sequences.map((values) => values.length));
	const sequence: number[] = [];
	for (let index = 0; index < maxLength; index++) {
		const values = sequences.map((entries) => entries[index]).filter((value) => value !== undefined);
		const value = medianOrNull(values);
		if (value === null) {
			return { first_turn_input_by_handoff_index: null, metrics_available: false };
		}
		sequence.push(value);
	}
	return { first_turn_input_by_handoff_index: sequence, metrics_available: true };
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
	const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as BenchmarkManifest & {
		attempts_per_instance?: number;
	};
	if (
		parsed.schema_version !== BENCHMARK_MANIFEST_SCHEMA_VERSION &&
		parsed.schema_version !== LEGACY_BENCHMARK_MANIFEST_SCHEMA_VERSION
	) {
		throw new BenchmarkReportError(`unsupported manifest schema_version: ${String(parsed.schema_version)}`);
	}
	return parsed.schema_version === BENCHMARK_MANIFEST_SCHEMA_VERSION
		? parsed
		: {
				...parsed,
				schema_version: BENCHMARK_MANIFEST_SCHEMA_VERSION,
				attempts_per_instance: 1,
			};
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
			const metrics = attempt.metrics as CaseAttemptRecord["metrics"] & {
				wall_breakdown?: CaseAttemptRecord["metrics"]["wall_breakdown"];
				time_to_first_patch_seconds?: number | null;
				waste?: WasteSummary;
				context_growth?: ContextGrowthSummary;
				handoffs?: CaseAttemptRecord["metrics"]["handoffs"];
			};
			attempt.metrics = {
				...metrics,
				handoffs: metrics.handoffs ?? {
					total: 0,
					pass: 0,
					fail: 0,
					blocked: 0,
					nonterminal: 0,
					blocked_reasons: {},
					unknown_blocked_reasons: 0,
					redelegations: 0,
					metrics_available: false,
				},
				wall_breakdown: metrics.wall_breakdown ?? {
					tool_execution_seconds: 0,
					provider_wait_derived_seconds: 0,
					local_overhead_derived_seconds: 0,
					attribution: "derived",
					metrics_available: false,
				},
				time_to_first_patch_seconds: metrics.time_to_first_patch_seconds ?? null,
				waste: metrics.waste ?? {
					rounds_in_non_pass_handoffs: null,
					tokens_in_non_pass_handoffs: null,
					waste_ratio_rounds: null,
					planner_rounds_ratio: null,
					handoff_reopens_per_goal_lane_median: null,
					metrics_available: false,
				},
				context_growth: metrics.context_growth ?? {
					first_turn_input_by_handoff_index: null,
					metrics_available: false,
				},
			};
		}
		cases.push(parsed);
	}
	return cases;
}

interface LedgerBreakdownInput {
	byRole: Record<string, BreakdownTotals>;
	byModel: Record<string, BreakdownTotals>;
	byLane: Record<string, BreakdownTotals>;
}

/**
 * Role/model/lane breakdowns come from the per-attempt ledgers under
 * `cases/` when present (hand-built report fixtures without ledgers simply
 * produce empty breakdowns).
 *
 * by_model joins two independently attributed ledgers (design §7):
 * - tool_calls are grouped by each requested row's RECORDED provider/model —
 *   never by role→model inference, so a role that switched models mid-attempt
 *   still gets exact per-model counts, and a model with zero rounds can carry
 *   calls (a budget stop can flush a tool row whose usage row was lost);
 * - rounds/tokens are grouped directly from every usage row's provider/model,
 *   including models that emitted zero tools. No dimension silently drops a
 *   zero-round tool call or a zero-tool model round.
 *
 * by_role and by_lane keep both dimensions from both ledgers, unchanged.
 */
function accumulateLedgers(outDir: string, cases: CaseFile[], out: LedgerBreakdownInput): void {
	for (const caseFile of cases) {
		const slug = caseFile.instance_id.replace(/\//g, "__");
		for (const attempt of caseFile.attempts) {
			const attemptDir = path.join(outDir, "cases", slug, "attempts", String(attempt.attempt));
			const usageRecords = readAttemptUsageRecords(path.join(attemptDir, "usage.jsonl"));
			const toolRecords = readToolCallRecords(path.join(attemptDir, "tool-calls.jsonl"));

			const callsByModel = new Map<string, number>();
			const callsByRole = new Map<string, number>();
			const callsByLane = new Map<string, number>();
			// Tool side first: the recorded attribution decides the model groups
			// without any role→model inference.
			for (const record of toolRecords) {
				if (record.kind !== "requested") continue;
				const modelKey = `${record.provider}/${record.model}`;
				callsByModel.set(modelKey, (callsByModel.get(modelKey) ?? 0) + 1);
				callsByRole.set(record.role, (callsByRole.get(record.role) ?? 0) + 1);
				if (record.lane !== null) {
					callsByLane.set(record.lane, (callsByLane.get(record.lane) ?? 0) + 1);
				}
			}

			for (const record of usageRecords) {
				bump(out.byRole, record.role).model_rounds++;
				out.byRole[record.role].total_tokens += record.usage.total_tokens;
				const modelKey = `${record.provider}/${record.model}`;
				bump(out.byModel, modelKey).model_rounds++;
				out.byModel[modelKey].total_tokens += record.usage.total_tokens;
				if (record.lane !== null) {
					bump(out.byLane, record.lane).model_rounds++;
					out.byLane[record.lane].total_tokens += record.usage.total_tokens;
				}
			}

			// Recorded-field grouping: calls land on the model their rows name.
			for (const [modelKey, count] of callsByModel) {
				bump(out.byModel, modelKey).tool_calls += count;
			}
			for (const [role, count] of callsByRole) {
				bump(out.byRole, role).tool_calls += count;
			}
			for (const [lane, count] of callsByLane) {
				bump(out.byLane, lane).tool_calls += count;
			}
		}
	}
}

function addHandoffState(
	total: HandoffObservabilitySummary,
	byRole: Record<string, HandoffObservabilitySummary>,
	byLane: Record<string, HandoffObservabilitySummary>,
	state: HandoffStateProjection,
): void {
	total.metrics_available = true;
	addHandoffTerminal(total, state);

	const role = byRole[state.role] ?? emptyHandoffObservabilitySummary();
	role.metrics_available = true;
	byRole[state.role] = role;
	addHandoffTerminal(role, state);

	const laneKey = state.lane ?? "(unlaned)";
	const lane = byLane[laneKey] ?? emptyHandoffObservabilitySummary();
	lane.metrics_available = true;
	byLane[laneKey] = lane;
	addHandoffTerminal(lane, state);
}

function addHandoffTerminal(total: HandoffObservabilitySummary, state: HandoffStateProjection): void {
	total.total++;
	if (state.status === "blocked") {
		total.blocked++;
		total.unknown_blocked_reasons += state.unknown_blocked_reasons;
		for (const reason of state.blocked_reasons) {
			total.blocked_reasons[reason] = (total.blocked_reasons[reason] ?? 0) + 1;
		}
	} else if (state.status === "done") {
		if (state.result === "PASS") total.pass++;
		else if (state.result === "FAIL") total.fail++;
		else total.nonterminal++;
	} else {
		total.nonterminal++;
	}
	if (state.retry_of !== null) total.redelegations++;
}

function accumulateHandoffObservability(
	outDir: string,
	cases: CaseFile[],
): HandoffObservabilitySummary & {
	by_role: Record<string, HandoffObservabilitySummary>;
	by_lane: Record<string, HandoffObservabilitySummary>;
} {
	const total = emptyHandoffObservabilitySummary();
	const byRole: Record<string, HandoffObservabilitySummary> = {};
	const byLane: Record<string, HandoffObservabilitySummary> = {};
	for (const caseFile of cases) {
		const slug = caseFile.instance_id.replace(/\//g, "__");
		for (const attempt of caseFile.attempts) {
			const file = path.join(outDir, "cases", slug, "attempts", String(attempt.attempt), "telemetry", "handoff-states.json");
			if (!fs.existsSync(file)) continue;
			total.metrics_available = true;
			for (const state of readHandoffStateProjections(file)) addHandoffState(total, byRole, byLane, state);
		}
	}
	return { ...total, by_role: byRole, by_lane: byLane };
}

/** Reads <outDir> artifacts only — manifest, case files, predictions. */
export function buildBenchmarkReport(outDir: string): BenchmarkReport {
	const manifest = readManifest(outDir);
	// Validated for contract conformance; a corrupt predictions file must fail
	// loudly instead of masquerading as a complete run.
	const predictions = readPredictions(path.join(outDir, "predictions.jsonl"));
	const cases = readCases(outDir);
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

	const budgetTerminations = { model_rounds: 0, tool_calls: 0, total_tokens: 0, wall_seconds: 0, none: 0 };
	for (const attempt of attempts) {
		budgetTerminations[attempt.terminated_by ?? "none"]++;
	}

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
	let cacheAvailable = attempts.length > 0;
	for (const attempt of attempts) {
		cacheRead += attempt.metrics.tokens.cache_read;
		cacheWrite += attempt.metrics.tokens.cache_write;
		cacheInput += attempt.metrics.tokens.input;
		if (!attempt.metrics.tokens.cache_metrics_available) cacheAvailable = false;
	}
	const cacheDenominator = cacheInput + cacheRead + cacheWrite;
	const perAttemptCacheHitRates = attempts
		.filter((attempt) => attempt.metrics.tokens.cache_metrics_available && attempt.metrics.tokens.cache_hit_rate !== null)
		.map((attempt) => attempt.metrics.tokens.cache_hit_rate as number);

	const byTool: Record<string, number> = {};
	for (const attempt of attempts) {
		for (const [tool, count] of Object.entries(attempt.metrics.tool_calls_by_tool)) {
			byTool[tool] = (byTool[tool] ?? 0) + count;
		}
	}
	const breakdownInput: LedgerBreakdownInput = {
		byRole: {},
		byModel: {},
		byLane: {},
	};
	accumulateLedgers(outDir, cases, breakdownInput);

	const effective = manifest.budgets?.effective ?? DEFAULT_BENCHMARK_BUDGETS;
	const handoffObservability = accumulateHandoffObservability(outDir, cases);
	const attemptsPerInstance = manifest.attempts_per_instance ?? 1;
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
		schema_version: BENCHMARK_REPORT_SCHEMA_VERSION,
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
		model_rounds: {
			total: roundsTotal,
			median: median(roundsPerAttempt),
			p90: percentile90(roundsPerAttempt),
			primary: attempts.reduce((sum, a) => sum + a.metrics.primary_model_rounds, 0),
			support: attempts.reduce((sum, a) => sum + a.metrics.support_model_rounds, 0),
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
			prompt_tokens: cacheDenominator,
			hit_rate: cacheAvailable && cacheDenominator > 0 ? cacheRead / cacheDenominator : null,
			metrics_available: cacheAvailable,
			per_attempt_hit_rate: {
				median: medianOrNull(perAttemptCacheHitRates),
				p90: percentile90OrNull(perAttemptCacheHitRates),
			},
		},
		tool_calls_per_model_round: roundsTotal > 0 ? callsTotal / roundsTotal : null,
		breakdowns: {
			by_role: breakdownInput.byRole,
			by_model: breakdownInput.byModel,
			by_lane: breakdownInput.byLane,
			by_tool: byTool,
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
			handoffs: handoffObservability,
			waste: aggregateWaste(attempts),
			context_growth: aggregateContextGrowth(attempts),
		},
		comparison_keys: {
			dataset_id: manifest.dataset?.dataset_id ?? "",
			dataset_split: manifest.dataset?.split ?? "",
			dataset_revision: manifest.dataset?.revision ?? "",
			instance_set_digest: createHash("sha256").update([...selected].sort().join("\n")).digest("hex"),
			budgets: {
				model_rounds: effective.model_rounds,
				tool_calls: effective.tool_calls,
				total_tokens: effective.total_tokens,
				wall_seconds: effective.wall_seconds,
			},
			tool_network: manifest.tool_network ?? "disabled",
			harness_commit: manifest.harness?.commit ?? "",
		},
	};
}
