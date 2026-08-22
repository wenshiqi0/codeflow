/**
 * Termination and consumption accounting.
 *
 * Wall time is the only stop axis. Round, tool-call, and token consumption can
 * grow without bound in this unit contract; a stop still preserves and grades
 * partial work.
 */

import { afterEach, describe, expect, test } from "bun:test";
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
			role: "worker",
			provider: "fixture",
			model: "fixture-worker",
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

function scriptedDriver(events: any[], inputs: any[] = [], clock?: { now(): number }) {
	return {
		startAttempt(input: any) {
			inputs.push(input);
			return (async function* () {
				for (const event of events) {
					if (event.type === "round" && event.round.advance_ms && clock) {
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

describe("termination budgets and consumption metrics", () => {
	test("wall time is the only default termination budget", async () => {
		const mod = await bench();
		expect(mod.DEFAULT_BENCHMARK_BUDGETS).toEqual({ wall_seconds: 5400 });
		expect(mod.CONSUMPTION_METRICS).toEqual([
			"model_rounds",
			"tool_calls",
			"fresh_tokens",
			"total_tokens",
		]);
	});

	test("only wall-seconds is accepted as a budget override", async () => {
		const mod = await bench();
		expect(mod.parseBudgetOverrides(["wall-seconds=60"])).toEqual({ wall_seconds: 60 });
		expect(mod.parseBudgetOverrides(["wall_seconds=60"])).toEqual({ wall_seconds: 60 });
		for (const formerAxis of [
			"model-rounds=2",
			"tool-calls=2",
			"fresh-tokens=100",
			"total-tokens=100",
			"dollars=100",
		]) {
			expect(() => mod.parseBudgetOverrides([formerAxis])).toThrow();
		}
		expect(() => mod.parseBudgetOverrides(["wall-seconds=zero"])).toThrow();
		expect(() => mod.parseBudgetOverrides(["wall-seconds=0"])).toThrow();
	});

	test("large resource consumption never terminates an attempt", async () => {
		const mod = await bench();
		const budgets = mod.DEFAULT_BENCHMARK_BUDGETS;
		const state = {
			model_rounds: Number.MAX_SAFE_INTEGER,
			tool_calls: Number.MAX_SAFE_INTEGER,
			fresh_tokens: Number.MAX_SAFE_INTEGER,
			total_tokens: Number.MAX_SAFE_INTEGER,
			wall_seconds: 5399,
		};
		expect(mod.budgetTerminatedBy(state, budgets)).toBeNull();
		expect(
			mod.budgetTerminatedBy({ ...state, wall_seconds: 5400 }, budgets),
		).toBe("wall_seconds");
	});

	test("fresh tokens remain observational when cache reporting is absent", async () => {
		const mod = await bench();
		expect(
			mod.budgetTerminatedBy(
				{
					model_rounds: Number.MAX_SAFE_INTEGER,
					tool_calls: Number.MAX_SAFE_INTEGER,
					fresh_tokens: null,
					total_tokens: Number.MAX_SAFE_INTEGER,
					wall_seconds: 0,
				},
				{ wall_seconds: 1 },
			),
		).toBeNull();
	});
});

describe("wall stop through the runner", () => {
	test("rounds before the wall stop remain recorded, submitted, and evaluated", async () => {
		const mod = await bench();
		const outDir = makeTmpDir();
		let fakeNow = 1_000_000;
		const clock = { now: () => fakeNow };
		const inputs: any[] = [];
		const evalCalls: any[] = [];
		const driver = scriptedDriver(
			[
				{ type: "workspace_write", path: "fix.py", content: "def fix():\n  return 'FIXED'\n" },
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
		expect(attempt.metrics.model_rounds_total).toBe(1);
		expect(attempt.metrics.wall_seconds).toBeGreaterThanOrEqual(600);
		expect(result.report.budget_terminations.wall_seconds).toBe(1);
		expect(result.report.budget_terminations.none).toBe(0);
		expect(readJsonl(path.join(outDir, "predictions.jsonl"))[0].model_patch).toContain("FIXED");
		expect(evalCalls).toHaveLength(1);
		expect(inputs[0].budgets).toEqual({ wall_seconds: 600 });
		expect(inputs[0].wallDeadlineMs).toBe(1_600_000);
	});
});
