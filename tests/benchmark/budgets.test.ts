/**
 * Fair budgets (design §5, §13.7).
 *
 * Deterministic stops at every cap, with a driver-owned simulated clock so
 * wall time needs no real sleeping. Stopping must never discard the work: the
 * patch is still extracted, submitted, and evaluated, and the stop is recorded
 * as terminated_by — orthogonal to the verdict.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	cleanupTmpDirs,
	loadBenchmarkModule,
	makeTmpDir,
	readJson,
	readJsonl,
	SNAPSHOT,
} from "./helpers";

afterEach(cleanupTmpDirs);

async function bench(): Promise<any> {
	return loadBenchmarkModule();
}

function roundEvent(advanceMs: number, tokens = 100) {
	return {
		type: "round",
		round: {
			role: "coder",
			provider: "fixture",
			model: "fixture-coder",
			usage: {
				input: tokens - 10,
				output: 10,
				reasoning: 0,
				cache_read: 0,
				cache_write: 0,
				total_tokens: tokens,
				cost: null,
			},
			tool_calls: [{ call_id: `t-${advanceMs}`, tool: "bash", status: "succeeded" }],
			advance_ms: advanceMs,
		},
	};
}

/** A driver that advances the injected clock itself, as fixture drivers do. */
function scriptedDriver(events: any[], inputs: any[] = [], clock?: { now(): number }) {
	return {
		startAttempt(input: any) {
			inputs.push(input);
			return (async function* () {
				for (const event of events) {
					if (event.type === "round" && event.round.advance_ms && clock) {
						// advance the shared simulated clock, then emit
						const base = clock.now();
						(clock as any).now = () => base + event.round.advance_ms;
					}
					yield event;
				}
			})();
		},
	};
}

function spyEvaluator(verdict: string, calls: any[] = []) {
	return {
		async evaluate(request: any) {
			calls.push(request);
			return verdict;
		},
	};
}

describe("budget constants and parsing", () => {
	test("the design's hard caps are the defaults", async () => {
		const mod = await bench();
		expect(mod.DEFAULT_BENCHMARK_BUDGETS).toEqual({
			model_rounds: 120,
			tool_calls: 400,
			total_tokens: 3_000_000,
			wall_seconds: 5400,
		});
	});

	test("CLI budget spellings map to the budget names; junk is refused", async () => {
		const mod = await bench();
		expect(mod.parseBudgetOverrides(["model-rounds=5"])).toEqual({ model_rounds: 5 });
		expect(mod.parseBudgetOverrides(["tool-calls=10", "wall-seconds=60"])).toEqual({
			tool_calls: 10,
			wall_seconds: 60,
		});
		expect(() => mod.parseBudgetOverrides(["dollars=100"])).toThrow();
		expect(() => mod.parseBudgetOverrides(["model-rounds=zero"])).toThrow();
		expect(() => mod.parseBudgetOverrides(["model-rounds=0"])).toThrow();
	});

	test("stop detection: >= is a stop, canonical order breaks ties, null when clear", async () => {
		const mod = await bench();
		const budgets = mod.DEFAULT_BENCHMARK_BUDGETS;
		expect(mod.budgetTerminatedBy({ model_rounds: 119, tool_calls: 399, total_tokens: 2_999_999, wall_seconds: 5399 }, budgets)).toBeNull();
		expect(mod.budgetTerminatedBy({ model_rounds: 120, tool_calls: 0, total_tokens: 0, wall_seconds: 0 }, budgets)).toBe("model_rounds");
		expect(mod.budgetTerminatedBy({ model_rounds: 0, tool_calls: 400, total_tokens: 0, wall_seconds: 0 }, budgets)).toBe("tool_calls");
		expect(mod.budgetTerminatedBy({ model_rounds: 0, tool_calls: 0, total_tokens: 3_000_000, wall_seconds: 0 }, budgets)).toBe("total_tokens");
		expect(mod.budgetTerminatedBy({ model_rounds: 0, tool_calls: 0, total_tokens: 0, wall_seconds: 5400 }, budgets)).toBe("wall_seconds");
		// Several caps crossed at once: the canonical order names one deterministically.
		expect(
			mod.budgetTerminatedBy(
				{ model_rounds: 120, tool_calls: 400, total_tokens: 3_000_000, wall_seconds: 5400 },
				budgets,
			),
		).toBe("model_rounds");
	});
});

describe("deterministic stops through the runner (simulated clock)", () => {
	test("wall-time stop: rounds recorded up to the cap, patch still submitted and evaluated", async () => {
		const mod = await bench();
		const outDir = makeTmpDir();
		let fakeNow = 1_000_000;
		const clock = { now: () => fakeNow };
		const inputs: any[] = [];
		const evalCalls: any[] = [];
		const driver = scriptedDriver(
			[
				// A real workspace change, so the budget stop has work to still submit.
				{ type: "workspace_write", path: "fix.py", content: 'def fix():\n    return "FIXED_1005"\n' },
				roundEvent(600_000),
				roundEvent(600_000),
				roundEvent(600_000),
			],
			inputs,
			clock,
		);
		const result = await mod.runBenchmark({
			dataset: SNAPSHOT,
			instances: ["demo/demo-1005"],
			outDir,
			budgets: { wall_seconds: 600 },
			driver,
			evaluator: spyEvaluator("resolved", evalCalls),
			clock,
			codeflowCommit: "0".repeat(40),
		});

		const attempt = readJson(
			path.join(outDir, "cases", "demo__demo-1005", "case.json"),
		).attempts[0];
		expect(attempt.terminated_by).toBe("wall_seconds");
		expect(attempt.verdict).toBe("resolved");
		expect(attempt.execution_status).toBe("completed");
		expect(attempt.metrics.model_rounds_total).toBe(1); // stopped after the round that crossed 10 min
		expect(attempt.metrics.wall_seconds).toBeGreaterThanOrEqual(600);

		// The stop did not discard work: a prediction with a real patch exists...
		const predictions = readJsonl(path.join(outDir, "predictions.jsonl"));
		expect(predictions).toHaveLength(1);
		expect(predictions[0].model_patch).toContain("FIXED_1005");
		// ...and the evaluator still ran. A budget stop is not an unresolved.
		expect(evalCalls).toHaveLength(1);
		expect(result.report.budget_terminations.wall_seconds).toBe(1);
		expect(inputs).toHaveLength(1); // exactly one attempt — no restart after the stop
	});

	test("infra failure: verdict infra_error, no evaluator call, no silent retry", async () => {
		const mod = await bench();
		const outDir = makeTmpDir();
		const inputs: any[] = [];
		const evalCalls: any[] = [];
		const driver = scriptedDriver(
			[
				roundEvent(100),
				{ type: "workspace_write", path: "partial.py", content: "# partial\n" },
				{ type: "infra_error", error_class: "docker_daemon_unavailable" },
				roundEvent(100), // must never be played
			],
			inputs,
		);
		await mod.runBenchmark({
			dataset: SNAPSHOT,
			instances: ["demo/demo-1001"],
			outDir,
			driver,
			evaluator: spyEvaluator("resolved", evalCalls),
			clock: { now: () => 0 },
			codeflowCommit: "0".repeat(40),
		});

		const attempt = readJson(path.join(outDir, "cases", "demo__demo-1001", "case.json")).attempts[0];
		expect(attempt.execution_status).toBe("infra_error");
		expect(attempt.verdict).toBe("infra_error");
		expect(attempt.metrics.model_rounds_total).toBe(1); // the unplayed round never happened
		expect(evalCalls).toHaveLength(0); // never disguised as unresolved, never silently retried
		expect(inputs).toHaveLength(1);
		// The partial patch is still preserved as a prediction.
		const predictions = readJsonl(path.join(outDir, "predictions.jsonl"));
		expect(predictions).toHaveLength(1);
		expect(predictions[0].model_patch).toContain("# partial");
	});

	test("evaluation run ids are distinct per attempt and per benchmark run", async () => {
		const mod = await bench();
		const first = mod.newEvaluationRunId("bench-20260819-000000-aaaa", "demo/demo-1001", 1);
		const second = mod.newEvaluationRunId("bench-20260819-000000-aaaa", "demo/demo-1001", 2);
		const otherRun = mod.newEvaluationRunId("bench-20260819-000001-bbbb", "demo/demo-1001", 1);
		expect(new Set([first, second, otherRun]).size).toBe(3);
		expect(first).toContain("demo__demo-1001");
	});
});
