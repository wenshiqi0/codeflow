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
import { BENCHMARK_MANIFEST_SCHEMA_VERSION } from "./artifacts";
import { BENCHMARK_CASE_SCHEMA_VERSION } from "./artifacts";
import { DEFAULT_BENCHMARK_BUDGETS, type BudgetName } from "./budgets";
import { readPredictions } from "./predictions";
import { readAttemptUsageRecords } from "./tokens";
import { readToolCallRecords } from "./tool-calls";
import type { BenchmarkVerdict } from "./driver";

export const BENCHMARK_REPORT_SCHEMA_VERSION = 1;

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
	schema_version: 1;
	benchmark_run_id: string;
	generated_at: string;
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
	budget_terminations: { model_rounds: number; tool_calls: number; total_tokens: number; wall_seconds: number; none: number };
	model_rounds: { total: number; median: number; p90: number; primary: number; support: number; failed_attempts: number };
	tool_calls: { total: number; median: number; p90: number };
	tokens: { total: number; median: number; p90: number };
	per_resolved: { rounds: number | null; tool_calls: number | null; tokens: number | null };
	cache: { read: number; write: number; hit_rate: number | null; metrics_available: boolean };
	tool_calls_per_model_round: number | null;
	breakdowns: {
		by_role: Record<string, BreakdownTotals>;
		by_model: Record<string, BreakdownTotals>;
		by_lane: Record<string, BreakdownTotals>;
		by_tool: Record<string, number>;
	};
	wall_time: { total_seconds: number; median_seconds: number; p90_seconds: number; not_ranked: true };
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
	return {
		schema_version: BENCHMARK_REPORT_SCHEMA_VERSION,
		benchmark_run_id: manifest.benchmark_run_id,
		generated_at: nowIso(),
		counts,
		resolved_rate: denominator > 0 ? resolved / denominator : null,
		resolved_rate_denominator: denominator,
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
			hit_rate: cacheAvailable && cacheDenominator > 0 ? cacheRead / cacheDenominator : null,
			metrics_available: cacheAvailable,
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
