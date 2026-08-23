/**
 * Benchmark termination and consumption accounting.
 *
 * Wall time is the only termination axis: it is infrastructure liveness
 * protection, not a model-work budget. Rounds, tool calls, and tokens are
 * consumption metrics only; arbitrarily large values never stop inference.
 */

export type TerminationBudgetName = "wall_seconds";
export type ConsumptionMetricName = "model_rounds" | "tool_calls" | "fresh_tokens" | "total_tokens";

export type BudgetName = TerminationBudgetName;
export type BenchmarkBudgets = { wall_seconds: number };

/** Default 5400s (90 min); a hung attempt must remain stoppable. */
export const DEFAULT_BENCHMARK_BUDGETS: BenchmarkBudgets = {
	wall_seconds: 5_400,
};

export const CONSUMPTION_METRICS: readonly ConsumptionMetricName[] = [
	"model_rounds",
	"tool_calls",
	"fresh_tokens",
	"total_tokens",
];

export class BenchmarkBudgetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BenchmarkBudgetError";
	}
}

/** CLI kebab-case spellings (and their snake_case budget names). */
const BUDGET_NAMES: Record<string, TerminationBudgetName> = {
	"wall-seconds": "wall_seconds",
	wall_seconds: "wall_seconds",
};

/**
 * Parse repeatable `<name>=<value>` termination-budget overrides.
 * Consumption metrics are intentionally not accepted here.
 */
export function parseBudgetOverrides(entries: string[]): Partial<BenchmarkBudgets> {
	const overrides: Partial<BenchmarkBudgets> = {};
	for (const entry of entries) {
		const equals = entry.indexOf("=");
		const rawName = equals === -1 ? "" : entry.slice(0, equals).trim();
		const rawValue = equals === -1 ? "" : entry.slice(equals + 1).trim();
		const name = BUDGET_NAMES[rawName];
		if (name === undefined) {
			throw new BenchmarkBudgetError(
				`invalid budget entry '${entry}': expected wall-seconds=<positive-integer>`,
			);
		}
		const value = Number(rawValue);
		if (!Number.isInteger(value) || value <= 0) {
			throw new BenchmarkBudgetError(
				`invalid budget value for ${rawName}: '${rawValue}' (must be a positive integer)`,
			);
		}
		overrides[name] = value;
	}
	return overrides;
}

/** Validate already-structured overrides (module callers) like CLI entries. */
export function validateBudgetOverrides(overrides: Partial<BenchmarkBudgets> | undefined): void {
	if (overrides === undefined || overrides === null) return;
	for (const name of Object.keys(overrides) as TerminationBudgetName[]) {
		if (!BUDGET_NAMES[name]) throw new BenchmarkBudgetError(`unknown budget name: ${name}`);
		const value = overrides[name];
		if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
			throw new BenchmarkBudgetError(
				`invalid budget value for ${name}: ${String(value)} (must be a positive integer)`,
			);
		}
	}
}

/** All measured consumption plus the wall-time termination axis. */
export interface BudgetState {
	model_rounds: number;
	tool_calls: number;
	/** Null when any round omitted cache fields; absence never becomes zero. */
	fresh_tokens: number | null;
	total_tokens: number;
	wall_seconds: number;
}

/** Wall time is the only cap. Large consumption values remain observational. */
export function budgetTerminatedBy(state: BudgetState, budgets: BenchmarkBudgets): BudgetName | null {
	return state.wall_seconds >= budgets.wall_seconds ? "wall_seconds" : null;
}

/** Wall time counts from attempt start using the injected clock. */
export interface BenchmarkClock {
	/** Epoch milliseconds. */
	now(): number;
}
