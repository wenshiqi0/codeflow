/**
 * Token and prompt-cache accounting (design §8, §13.6).
 *
 * Two distinctions carry the whole file:
 * 1. Provider-reported zero is data; an unreported cache field is absence.
 *    Missing fields must not be laundered into a 0% hit rate.
 * 2. The aggregate hit rate is token-weighted, never an average of per-round
 *    percentages — averaging would let one tiny cached round fake efficiency.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanupTmpDirs, loadBenchmarkModule } from "./helpers";

afterEach(cleanupTmpDirs);

async function bench(): Promise<any> {
	return loadBenchmarkModule();
}

function record(usage: Record<string, unknown>) {
	return {
		schema_version: 1,
		at: "2026-01-01T00:00:00Z",
		attempt: 1,
		role: "coder",
		provider: "fixture",
		model: "fixture-coder",
		handoff_id: null,
		goal_id: null,
		lane: null,
		usage,
	};
}

describe("explicit zero vs unreported", () => {
	test("explicit zeros keep cache metrics available, even at a 0 rate", async () => {
		const mod = await bench();
		const summary = mod.summarizeTokenUsage([
			record({ input: 100, output: 10, reasoning: 0, cache_read: 0, cache_write: 0, total_tokens: 110, cost: null }),
		]);
		expect(summary.cache_metrics_available).toBe(true);
		expect(summary.cache_hit_rate).toBe(0);
	});

	test("unreported cache fields force availability false and a null hit rate", async () => {
		const mod = await bench();
		const summary = mod.summarizeTokenUsage([
			// cache keys absent: the provider does not support the metric.
			record({ input: 100, output: 10, reasoning: 0, total_tokens: 110, cost: null }),
		]);
		expect(summary.cache_metrics_available).toBe(false);
		expect(summary.cache_hit_rate).toBeNull();
		// Sums still exist for display; absence counts as 0 there.
		expect(summary.cache_read).toBe(0);
		expect(summary.cache_write).toBe(0);
	});

	test("one unreported round poisons the whole attempt's availability", async () => {
		const mod = await bench();
		const summary = mod.summarizeTokenUsage([
			record({ input: 10, output: 1, reasoning: 0, cache_read: 50, cache_write: 0, total_tokens: 61, cost: null }),
			record({ input: 10, output: 1, reasoning: 0, total_tokens: 11, cost: null }),
		]);
		expect(summary.cache_metrics_available).toBe(false);
		expect(summary.cache_hit_rate).toBeNull();
	});

	test("no rounds at all: unavailable, null rate — not 0%", async () => {
		const mod = await bench();
		const summary = mod.summarizeTokenUsage([]);
		expect(summary.cache_metrics_available).toBe(false);
		expect(summary.cache_hit_rate).toBeNull();
	});

	test("an all-zero denominator still yields null, never NaN", async () => {
		const mod = await bench();
		const summary = mod.summarizeTokenUsage([
			record({ input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total_tokens: 0, cost: null }),
		]);
		expect(summary.cache_metrics_available).toBe(true);
		expect(summary.cache_hit_rate).toBeNull();
	});
});

describe("token-weighted cache hit rate", () => {
	test("weights by token volume, not by round count", async () => {
		const mod = await bench();
		// Round 1: 90% hit rate on a tiny round. Round 2: 0% on a huge round.
		// Mean-of-percentages would say 45%; the contract says 90/1100.
		const summary = mod.summarizeTokenUsage([
			record({ input: 10, output: 5, reasoning: 0, cache_read: 90, cache_write: 0, total_tokens: 105, cost: null }),
			record({ input: 1000, output: 50, reasoning: 10, cache_read: 0, cache_write: 0, total_tokens: 1060, cost: null }),
		]);
		expect(summary.cache_metrics_available).toBe(true);
		expect(summary.cache_hit_rate).toBeCloseTo(90 / (10 + 1000 + 90 + 0 + 0), 12);
		expect(summary.cache_hit_rate).not.toBeCloseTo(0.45, 2);
		expect(summary.input).toBe(1010);
		expect(summary.cache_read).toBe(90);
		expect(summary.cache_write).toBe(0);
		expect(summary.total_tokens).toBe(1165);
	});

	test("cache write enters the denominator", async () => {
		const mod = await bench();
		const summary = mod.summarizeTokenUsage([
			record({ input: 10, output: 0, reasoning: 0, cache_read: 30, cache_write: 10, total_tokens: 50, cost: null }),
		]);
		expect(summary.cache_hit_rate).toBeCloseTo(30 / (10 + 30 + 10), 12);
	});

	test("reasoning tokens are not double-counted into total_tokens sums", async () => {
		const mod = await bench();
		const summary = mod.summarizeTokenUsage([
			// total_tokens is provider-reported; reasoning is an output subset.
			record({ input: 100, output: 50, reasoning: 20, cache_read: 0, cache_write: 0, total_tokens: 150, cost: null }),
		]);
		expect(summary.total_tokens).toBe(150);
		expect(summary.reasoning).toBe(20);
	});
});

describe("cost stays informational", () => {
	test("cost is carried for display but never a budget or ranking input", async () => {
		const mod = await bench();
		const summary = mod.summarizeTokenUsage([
			record({
				input: 100,
				output: 20,
				reasoning: 0,
				cache_read: 30,
				cache_write: 5,
				total_tokens: 155,
				cost: { input: 1, output: 2, cache_read: 0.5, cache_write: 0.25, total: 3.75 },
			}),
		]);
		expect(summary.cost_total).toBe(3.75);
		// No cost field exists anywhere in the budget contract (see budgets test),
		// and the budget cap names are resource counts only.
		for (const name of ["model_rounds", "tool_calls", "total_tokens", "wall_seconds"]) {
			expect(mod.DEFAULT_BENCHMARK_BUDGETS).toHaveProperty(name);
		}
		expect(Object.keys(mod.DEFAULT_BENCHMARK_BUDGETS).sort()).toEqual([
			"model_rounds",
			"tool_calls",
			"total_tokens",
			"wall_seconds",
		]);
	});
});
