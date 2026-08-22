/**
 * Fair per-instance budgets (design §5).
 *
 * Any cap reached stops further inference for that attempt, but the runner
 * still extracts the patch, submits the prediction, and requests a verdict —
 * a budget stop never forces `unresolved`. Wall time is a safety stop only and
 * never enters ranking. Cost is not a budget axis.
 */

export type BudgetName =
	| "model_rounds"
	| "tool_calls"
	| "fresh_tokens"
	| "total_tokens"
	| "wall_seconds";

export interface BenchmarkBudgets {
	/** Default 120 completed model rounds per instance attempt. */
	model_rounds: number;
	/** Default 400 top-level tool calls per instance attempt. */
	tool_calls: number;
	/** Default 300,000 non-cache input + output tokens per instance attempt. */
	fresh_tokens: number;
	/** Default 3,000,000 provider-reported total tokens per instance attempt. */
	total_tokens: number;
	/** Default 5400s (90 min) wall time; safety stop only, not ranked. */
	wall_seconds: number;
}

/** The design-pinned hard caps. Budget changes after the pilot are versioned. */
export const DEFAULT_BENCHMARK_BUDGETS: BenchmarkBudgets = {
	model_rounds: 120,
	tool_calls: 400,
	fresh_tokens: 300_000,
	total_tokens: 3_000_000,
	wall_seconds: 5_400,
};

export class BenchmarkBudgetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BenchmarkBudgetError";
	}
}

/** CLI kebab-case spellings (and their snake_case budget names) map to canonical names. */
const BUDGET_NAMES: Record<string, BudgetName> = {
	"model-rounds": "model_rounds",
	model_rounds: "model_rounds",
	"tool-calls": "tool_calls",
	tool_calls: "tool_calls",
	"fresh-tokens": "fresh_tokens",
	fresh_tokens: "fresh_tokens",
	"total-tokens": "total_tokens",
	total_tokens: "total_tokens",
	"wall-seconds": "wall_seconds",
	wall_seconds: "wall_seconds",
};

/**
 * Parse repeatable `<name>=<value>` budget override entries.
 * Unknown names and non-positive-integer values throw {@link BenchmarkBudgetError};
 * zero is refused because a zero cap is a misconfiguration, not a budget.
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
				`invalid budget entry '${entry}': expected <name>=<value> with name one of ` +
					"model-rounds|tool-calls|fresh-tokens|total-tokens|wall-seconds",
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

/** Validate already-structured overrides (module callers) the same way the CLI ones are. */
export function validateBudgetOverrides(overrides: Partial<BenchmarkBudgets> | undefined): void {
	if (overrides === undefined || overrides === null) return;
	for (const name of Object.keys(overrides) as BudgetName[]) {
		if (!BUDGET_NAMES[name]) {
			throw new BenchmarkBudgetError(`unknown budget name: ${name}`);
		}
		const value = overrides[name];
		if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
			throw new BenchmarkBudgetError(
				`invalid budget value for ${name}: ${String(value)} (must be a positive integer)`,
			);
		}
	}
}

export interface BudgetState {
	model_rounds: number;
	tool_calls: number;
	/** Null when any round omitted cache fields; absence never becomes zero. */
	fresh_tokens: number | null;
	total_tokens: number;
	wall_seconds: number;
}

const CANONICAL_ORDER: readonly BudgetName[] = [
	"model_rounds",
	"tool_calls",
	"fresh_tokens",
	"total_tokens",
	"wall_seconds",
];

/**
 * First cap reached, in canonical order model_rounds, tool_calls,
 * fresh_tokens, total_tokens, wall_seconds; null when no cap is reached. A cap is reached
 * when the current count is `>=` the cap (a 120-round cap allows at most 120
 * completed rounds; the attempt stops before issuing round 121).
 */
export function budgetTerminatedBy(state: BudgetState, budgets: BenchmarkBudgets): BudgetName | null {
	for (const name of CANONICAL_ORDER) {
		if (state[name] === null) continue;
		if (state[name] >= budgets[name]) return name;
	}
	return null;
}

/** Wall time counts from attempt start using the injected clock. */
export interface BenchmarkClock {
	/** Epoch milliseconds. */
	now(): number;
}
