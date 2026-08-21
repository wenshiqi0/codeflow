/**
 * Per-attempt usage ledger rows and token/cache accounting (design §8).
 *
 * One row is one completed model round (the same fact the run-level usage
 * ledger records: one assistant response with usage). Rows carry attribution
 * and numbers only.
 *
 * Cache semantics are load-bearing: a provider-reported 0 is data; an absent
 * field means "not reported". Unreported cache fields keep the sums (as 0 for
 * display) but force `cache_metrics_available: false` and a null hit rate for
 * the whole attempt — absence must never be laundered into a 0% rate.
 *
 * The aggregate hit rate is token-weighted:
 *   sum(cache_read) / sum(input + cache_read + cache_write)
 * never an average of per-round percentages. Reasoning tokens are an output
 * subset and are never added into provider-reported totals. Cost is
 * informational only.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const ATTEMPT_USAGE_SCHEMA_VERSION = 2;
export const LEGACY_ATTEMPT_USAGE_SCHEMA_VERSION = 1;

export interface AttemptUsageCost {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	total: number;
}

/** Usage as reported for one completed model round; cache null = not reported. */
export interface AttemptUsage {
	input: number;
	output: number;
	reasoning: number;
	cache_read: number | null;
	cache_write: number | null;
	/** Provider-reported total; cache tokens included, reasoning is an output subset. */
	total_tokens: number;
	/** Informational only; never a budget or ranking axis. */
	cost: AttemptUsageCost | null;
}

/** One completed model round as recorded per attempt. */
export interface AttemptUsageRecord {
	schema_version: 2;
	/** ISO timestamp. */
	at: string;
	/** Null for provider requests whose start boundary was not observed. */
	request_started_at: string | null;
	attempt: number;
	run_id: string | null;
	role: string;
	provider: string;
	model: string;
	depth: number | null;
	turn: number | null;
	handoff_id: string | null;
	goal_id: string | null;
	lane: string | null;
	usage: AttemptUsage;
}

const RECORD_KEYS_V2 = [
	"schema_version",
	"at",
	"request_started_at",
	"attempt",
	"run_id",
	"role",
	"provider",
	"model",
	"depth",
	"turn",
	"handoff_id",
	"goal_id",
	"lane",
	"usage",
] as const;
const RECORD_KEYS_V1 = [
	"schema_version",
	"at",
	"attempt",
	"role",
	"provider",
	"model",
	"handoff_id",
	"goal_id",
	"lane",
	"usage",
] as const;
const USAGE_KEYS = [
	"input",
	"output",
	"reasoning",
	"cache_read",
	"cache_write",
	"total_tokens",
	"cost",
] as const;
const COST_KEYS = ["input", "output", "cache_read", "cache_write", "total"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact key set + number/null shape check, so ledgers stay attribution + numbers only. */
export function validateAttemptUsageRecord(record: unknown): string[] {
	const violations: string[] = [];
	if (!isObject(record)) return ["record must be a JSON object"];
	const keys = record.schema_version === LEGACY_ATTEMPT_USAGE_SCHEMA_VERSION ? RECORD_KEYS_V1 : RECORD_KEYS_V2;
	for (const key of Object.keys(record)) {
		if (!(keys as readonly string[]).includes(key)) {
			violations.push(`unexpected key: ${key} (usage rows carry attribution and numbers only)`);
		}
	}
	for (const key of keys) {
		if (!(key in record)) violations.push(`missing key: ${key}`);
	}
	if (record.schema_version !== ATTEMPT_USAGE_SCHEMA_VERSION && record.schema_version !== LEGACY_ATTEMPT_USAGE_SCHEMA_VERSION) {
		violations.push(`schema_version must be ${LEGACY_ATTEMPT_USAGE_SCHEMA_VERSION} or ${ATTEMPT_USAGE_SCHEMA_VERSION}`);
	}
	if (typeof record.at !== "string" || Number.isNaN(Date.parse(record.at))) {
		violations.push("at must be an ISO timestamp string");
	}
	if (typeof record.attempt !== "number" || !Number.isInteger(record.attempt) || record.attempt < 1) {
		violations.push("attempt must be a positive integer");
	}
	for (const key of ["role", "provider", "model"] as const) {
		if (typeof record[key] !== "string" || record[key].length === 0) {
			violations.push(`${key} must be a non-empty string`);
		}
	}
	for (const key of ["handoff_id", "goal_id", "lane"] as const) {
		if (record[key] !== null && typeof record[key] !== "string") {
			violations.push(`${key} must be a string or null`);
		}
	}
	for (const key of ["request_started_at", "run_id"] as const) {
		if (record.schema_version === LEGACY_ATTEMPT_USAGE_SCHEMA_VERSION) continue;
		if (record[key] !== null && typeof record[key] !== "string") {
			violations.push(`${key} must be a string or null`);
		}
		if (record[key] === null) continue;
		if (key === "request_started_at" && Number.isNaN(Date.parse(record[key] as string))) {
			violations.push("request_started_at must be an ISO timestamp string or null");
		}
		if (key === "run_id" && (record[key] as string).length === 0) {
			violations.push("run_id must be a non-empty string or null");
		}
	}
	for (const key of ["depth", "turn"] as const) {
		if (record.schema_version === LEGACY_ATTEMPT_USAGE_SCHEMA_VERSION) continue;
		const value = record[key];
		if (value !== null && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
			violations.push(`${key} must be a non-negative integer or null`);
		}
	}
	const usage = record.usage;
	if (!isObject(usage)) {
		violations.push("usage must be an object");
		return violations;
	}
	for (const key of Object.keys(usage)) {
		if (!(USAGE_KEYS as readonly string[]).includes(key)) {
			violations.push(`unexpected usage key: ${key}`);
		}
	}
	for (const key of ["input", "output", "reasoning", "total_tokens"] as const) {
		if (typeof usage[key] !== "number" || !Number.isFinite(usage[key])) {
			violations.push(`usage.${key} must be a finite number`);
		}
	}
	for (const key of ["cache_read", "cache_write"] as const) {
		const value = usage[key];
		if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
			violations.push(`usage.${key} must be a finite number or null (not reported)`);
		}
	}
	const cost = usage.cost;
	if (cost !== null) {
		if (!isObject(cost)) {
			violations.push("usage.cost must be an object or null");
		} else {
			for (const key of Object.keys(cost)) {
				if (!(COST_KEYS as readonly string[]).includes(key)) {
					violations.push(`unexpected usage.cost key: ${key}`);
				}
			}
			for (const key of COST_KEYS) {
				if (typeof cost[key] !== "number" || !Number.isFinite(cost[key])) {
					violations.push(`usage.cost.${key} must be a finite number`);
				}
			}
		}
	}
	return violations;
}

export function appendAttemptUsageRecord(file: string, record: AttemptUsageRecord): void {
	const violations = validateAttemptUsageRecord(record);
	if (violations.length > 0) {
		throw new Error(`refusing attempt usage row: ${violations.join("; ")}`);
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

/** Appends any strictly-shaped JSONL row (e.g. failed model attempts). */
export function appendJsonlRow(file: string, row: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
}

/** Reads parsed rows; missing file is empty, malformed lines throw loudly. */
export function readJsonlRows(file: string): Record<string, unknown>[] {
	let content: string;
	try {
		content = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const rows: Record<string, unknown>[] = [];
	const lines = content.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line.trim().length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!isObject(parsed)) throw new Error("not an object");
			rows.push(parsed);
		} catch (error) {
			throw new Error(`ledger line ${index + 1} in ${file} is malformed: ${(error as Error).message}`);
		}
	}
	return rows;
}

export function readAttemptUsageRecords(file: string): AttemptUsageRecord[] {
	return readJsonlRows(file).map((row, index) => {
		const violations = validateAttemptUsageRecord(row);
		if (violations.length > 0) {
			throw new Error(`usage row ${index + 1} in ${file}: ${violations.join("; ")}`);
		}
		if (row.schema_version === ATTEMPT_USAGE_SCHEMA_VERSION) return row as unknown as AttemptUsageRecord;
		return {
			...row,
			schema_version: ATTEMPT_USAGE_SCHEMA_VERSION,
			request_started_at: null,
			run_id: null,
			depth: null,
			turn: null,
		} as AttemptUsageRecord;
	});
}

export interface TokenUsageSummary {
	input: number;
	output: number;
	reasoning: number;
	/** Unreported counts as 0 in sums. */
	cache_read: number;
	cache_write: number;
	total_tokens: number;
	/** Informational only; null when no round reported a cost. */
	cost_total: number | null;
	/** True iff >= 1 record and every record reported both cache fields. */
	cache_metrics_available: boolean;
	/** Token-weighted; null when unavailable or the denominator is 0. */
	cache_hit_rate: number | null;
}

/** Absent (undefined) and null both mean "not reported"; a finite number (incl. 0) is data. */
function cacheReported(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function summarizeTokenUsage(records: AttemptUsageRecord[]): TokenUsageSummary {
	const totals = {
		input: 0,
		output: 0,
		reasoning: 0,
		cache_read: 0,
		cache_write: 0,
		total_tokens: 0,
	};
	let cacheAvailable = records.length > 0;
	let costKnown = false;
	let costTotal = 0;

	for (const record of records) {
		const usage = record.usage;
		totals.input += usage.input;
		totals.output += usage.output;
		totals.reasoning += usage.reasoning;
		totals.cache_read += usage.cache_read ?? 0;
		totals.cache_write += usage.cache_write ?? 0;
		totals.total_tokens += usage.total_tokens;
		if (!cacheReported(usage.cache_read) || !cacheReported(usage.cache_write)) cacheAvailable = false;
		if (usage.cost !== null) {
			costKnown = true;
			costTotal += usage.cost.total;
		}
	}

	const denominator = totals.input + totals.cache_read + totals.cache_write;
	const hitRate = cacheAvailable && denominator > 0 ? totals.cache_read / denominator : null;

	return {
		input: totals.input,
		output: totals.output,
		reasoning: totals.reasoning,
		cache_read: totals.cache_read,
		cache_write: totals.cache_write,
		total_tokens: totals.total_tokens,
		cost_total: costKnown ? costTotal : null,
		cache_metrics_available: cacheAvailable,
		cache_hit_rate: hitRate,
	};
}
