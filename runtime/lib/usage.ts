/**
 * Attributed model usage: one assistant response is one model round.
 *
 * The ledger is append-only JSONL because goal lanes can run concurrently.
 * Aggregation happens on read, and the depth-0 runner writes the final report
 * after every child has exited.
 */

import * as fs from "node:fs";
import { type RunPaths, nowIso, writeJsonAtomic } from "./paths";

export const USAGE_SCHEMA_VERSION = 1;

export interface UsageCost {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	total: number;
}

export interface NormalizedUsage {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	reasoning: number;
	total_tokens: number;
	cost: UsageCost;
}

export interface UsageRecord {
	schema_version: number;
	at: string;
	run_id: string;
	role: string;
	depth: number;
	handoff_id: string | null;
	goal_id: string | null;
	lane: string | null;
	turn: number;
	provider: string;
	model: string;
	response_model: string;
	usage: NormalizedUsage;
}

export interface UsageTotals {
	calls: number;
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	reasoning: number;
	total_tokens: number;
	cost_input: number;
	cost_output: number;
	cost_cache_read: number;
	cost_cache_write: number;
	cost_total: number;
}

export interface ModelUsage extends UsageTotals {
	provider: string;
	model: string;
}

export interface UsageReport {
	schema_version: number;
	run_id: string;
	generated_at: string;
	records: UsageRecord[];
	models: ModelUsage[];
	total: UsageTotals;
}

function number(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function string(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function normalizeCost(value: unknown): UsageCost {
	const cost = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
	return {
		input: number(cost.input),
		output: number(cost.output),
		cache_read: number(cost.cacheRead ?? cost.cache_read),
		cache_write: number(cost.cacheWrite ?? cost.cache_write),
		total: number(cost.total),
	};
}

function normalizeUsage(value: unknown): NormalizedUsage | null {
	if (typeof value !== "object" || value === null) return null;
	const usage = value as Record<string, unknown>;
	return {
		input: number(usage.input),
		output: number(usage.output),
		cache_read: number(usage.cacheRead ?? usage.cache_read),
		cache_write: number(usage.cacheWrite ?? usage.cache_write),
		reasoning: number(usage.reasoning),
		total_tokens: number(usage.totalTokens ?? usage.total_tokens),
		cost: normalizeCost(usage.cost),
	};
}

function env(name: string): string | undefined {
	const value = process.env[name];
	return value === "" ? undefined : value;
}

export function usageRecordFromMessage(message: unknown, turn: number): UsageRecord | null {
	if (typeof message !== "object" || message === null) return null;
	const messageRecord = message as Record<string, unknown>;
	if (messageRecord.role !== "assistant") return null;

	const usage = normalizeUsage(messageRecord.usage);
	const provider = string(messageRecord.provider);
	const responseModel = string(messageRecord.responseModel);
	const model = responseModel || string(messageRecord.model);
	const runId = env("CODEFLOW_RUN_ID");
	if (usage === null || provider === "" || model === "" || runId === undefined) return null;

	const timestamp = number(messageRecord.timestamp);
	return {
		schema_version: USAGE_SCHEMA_VERSION,
		at: timestamp > 0 ? new Date(timestamp).toISOString() : nowIso(),
		run_id: runId,
		role: env("CODEFLOW_AGENT_ROLE") ?? "unknown",
		depth: number(env("CODEFLOW_AGENT_DEPTH")),
		handoff_id: env("CODEFLOW_HANDOFF_ID") ?? null,
		goal_id: env("CODEFLOW_GOAL_ID") ?? null,
		lane: env("CODEFLOW_LANE") ?? null,
		turn,
		provider,
		model,
		response_model: model,
		usage,
	};
}

export function appendUsageRecord(paths: RunPaths, record: UsageRecord): void {
	fs.mkdirSync(paths.runDir, { recursive: true });
	fs.appendFileSync(paths.usageLedger, `${JSON.stringify(record)}\n`, "utf8");
}

export function readUsageRecords(paths: RunPaths): UsageRecord[] {
	try {
		const content = fs.readFileSync(paths.usageLedger, "utf8");
		return content
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as UsageRecord);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function emptyTotals(): UsageTotals {
	return {
		calls: 0,
		input: 0,
		output: 0,
		cache_read: 0,
		cache_write: 0,
		reasoning: 0,
		total_tokens: 0,
		cost_input: 0,
		cost_output: 0,
		cost_cache_read: 0,
		cost_cache_write: 0,
		cost_total: 0,
	};
}

function addUsage(totals: UsageTotals, usage: NormalizedUsage): void {
	totals.calls += 1;
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cache_read += usage.cache_read;
	totals.cache_write += usage.cache_write;
	totals.reasoning += usage.reasoning;
	totals.total_tokens += usage.total_tokens;
	totals.cost_input += usage.cost.input;
	totals.cost_output += usage.cost.output;
	totals.cost_cache_read += usage.cost.cache_read;
	totals.cost_cache_write += usage.cost.cache_write;
	totals.cost_total += usage.cost.total;
}

export function buildUsageReport(runId: string, records: UsageRecord[]): UsageReport {
	const byModel = new Map<string, { provider: string; model: string; totals: UsageTotals }>();
	const total = emptyTotals();

	for (const record of records) {
		const key = `${record.provider}/${record.model}`;
		let entry = byModel.get(key);
		if (!entry) {
			entry = { provider: record.provider, model: record.model, totals: emptyTotals() };
			byModel.set(key, entry);
		}
		addUsage(entry.totals, record.usage);
		addUsage(total, record.usage);
	}

	return {
		schema_version: USAGE_SCHEMA_VERSION,
		run_id: runId,
		generated_at: nowIso(),
		records,
		models: [...byModel.entries()]
			.map(([key, entry]) => ({ provider: entry.provider, model: key, ...entry.totals }))
			.sort((a, b) => a.model.localeCompare(b.model)),
		total,
	};
}

export function writeUsageSummary(paths: RunPaths): string {
	const report = buildUsageReport(paths.runId, readUsageRecords(paths));
	writeJsonAtomic(paths.usageSummary, report);
	return paths.usageSummary;
}

export function renderUsageSummary(report: UsageReport): string {
	const models = report.models
		.map((model) =>
			`${model.model} calls=${model.calls} in=${model.input} out=${model.output} cache_r=${model.cache_read} cache_w=${model.cache_write} reasoning=${model.reasoning} tokens=${model.total_tokens} cost=${model.cost_total}`,
		)
		.join("\n");
	const total = report.total;
	return [
		`codeflow usage run=${report.run_id}`,
		models,
		`total calls=${total.calls} in=${total.input} out=${total.output} cache_r=${total.cache_read} cache_w=${total.cache_write} reasoning=${total.reasoning} tokens=${total.total_tokens} cost=${total.cost_total}`,
	].join("\n");
}
