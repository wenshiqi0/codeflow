/**
 * report.json aggregation (design §9, §11, §13.9).
 *
 * Correctness gates the report; efficiency follows. Three properties are
 * load-bearing:
 * - The resolved-rate denominator is valid official verdicts only, and the
 *   excluded infra_error / not_evaluated counts stay visible — a smaller
 *   denominator must never hide missing results.
 * - Per-resolved numerators include failed-but-infra-valid attempts, so a
 *   configuration cannot win by failing fast.
 * - There is no composite score: cost and wall time are informational, wall
 *   time is explicitly not_ranked.
 *
 * These tests hand-build an output directory and call the module-level
 * builder, so the math is pinned independently of any driver or CLI.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTmpDirs, loadBenchmarkModule, makeTmpDir } from "./helpers";

afterEach(cleanupTmpDirs);

async function bench(): Promise<any> {
	return loadBenchmarkModule();
}

function metrics(overrides: Record<string, unknown> = {}) {
	return {
		model_rounds_total: 0,
		primary_model_rounds: 0,
		support_model_rounds: 0,
		failed_model_attempts: 0,
		tool_calls_total: 0,
		tool_call_counts: {
			requested: 0,
			completed: 0,
			succeeded: 0,
			failed: 0,
			rejected: 0,
			incomplete: 0,
		},
		tool_calls_by_tool: {},
		tool_calls_per_model_round: null,
		tokens: {
			input: 0,
			output: 0,
			reasoning: 0,
			cache_read: 0,
			cache_write: 0,
			total_tokens: 0,
			cost_total: null,
			cache_metrics_available: false,
			cache_hit_rate: null,
		},
		wall_seconds: 0,
		terminated_by: null,
		...overrides,
	};
}

function writeOutDir(
	dir: string,
	cases: Array<{ id: string; verdict: string; terminated_by?: string | null; metrics: any }>,
): void {
	const ids = cases.map((c) => c.id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "benchmark-run.json"),
		JSON.stringify({
			schema_version: 1,
			benchmark_run_id: "bench-20260819-000000-test",
			created_at: "2026-08-19T00:00:00Z",
			dataset: {
				dataset_id: "SWE-bench/SWE-bench_Verified",
				split: "test",
				revision: "78f471bf655a3137b2e8a75af1501690ec009ec3",
				source: "local-snapshot",
				instance_count: ids.length,
			},
			instances: { allowlist: null, selected: ids },
			harness: { commit: "7a21e05772954cc81471ae19d56f436cecf43c54" },
			codeflow_commit: "6ce5819dcb5cf5d472ebb5c99b8ae32f42760f7a",
			model_config: "test-config",
			concurrency: 1,
			tool_network: "disabled",
			model_provider_network: "disabled",
			budgets: {
				defaults: { model_rounds: 120, tool_calls: 400, total_tokens: 3000000, wall_seconds: 5400 },
				overrides: null,
				effective: {
					model_rounds: 120,
					tool_calls: 400,
					total_tokens: 3000000,
					wall_seconds: 5400,
				},
			},
			driver_mode: "fixture",
		}),
	);
	fs.writeFileSync(
		path.join(dir, "predictions.jsonl"),
		cases
			.map((c) =>
				JSON.stringify({
					instance_id: c.id,
					model_name_or_path: "fixture/fake-model",
					model_patch: "diff --git a/fix.py b/fix.py\n",
				}),
			)
			.concat("")
			.join("\n"),
	);
	for (const c of cases) {
		const caseDir = path.join(dir, "cases", c.id.replace(/\//g, "__"));
		fs.mkdirSync(caseDir, { recursive: true });
		fs.writeFileSync(
			path.join(caseDir, "case.json"),
			JSON.stringify({
				schema_version: 1,
				instance_id: c.id,
				attempts: [
					{
						attempt: 1,
						execution_status: "completed",
						terminated_by: c.terminated_by ?? null,
						evaluation_run_id: `bench-20260819-000000-test--${c.id.replace(/\//g, "__")}--a1`,
						verdict: c.verdict,
						started_at: "2026-08-19T00:00:00Z",
						ended_at: "2026-08-19T00:01:00Z",
						metrics: { ...c.metrics, terminated_by: c.terminated_by ?? null },
					},
				],
				final_verdict: c.verdict,
			}),
		);
	}
}

describe("classification counts and the resolved-rate denominator", () => {
	test("partial or mismatched artifacts fail loudly instead of shrinking the denominator", async () => {
		const mod = await bench();
		const dir = makeTmpDir();
		writeOutDir(dir, [
			{ id: "demo/r", verdict: "resolved", metrics: metrics() },
			{ id: "demo/u", verdict: "unresolved", metrics: metrics() },
		]);
		fs.rmSync(path.join(dir, "cases", "demo__u"), { recursive: true });
		expect(() => mod.buildBenchmarkReport(dir)).toThrow(/case artifacts do not match manifest selection/);

		writeOutDir(dir, [
			{ id: "demo/r", verdict: "resolved", metrics: metrics() },
			{ id: "demo/u", verdict: "unresolved", metrics: metrics() },
		]);
		fs.writeFileSync(
			path.join(dir, "predictions.jsonl"),
			`${JSON.stringify({ instance_id: "demo/r", model_name_or_path: "m", model_patch: "" })}\n`,
		);
		expect(() => mod.buildBenchmarkReport(dir)).toThrow(/exactly one entry per selected instance/);
	});

	test("denominator = valid verdicts only; infra_error and not_evaluated stay visible", async () => {
		const mod = await bench();
		const dir = makeTmpDir();
		writeOutDir(dir, [
			{ id: "demo/r", verdict: "resolved", metrics: metrics() },
			{ id: "demo/u", verdict: "unresolved", metrics: metrics() },
			{ id: "demo/i", verdict: "infra_error", metrics: metrics() },
			{ id: "demo/p", verdict: "not_evaluated", metrics: metrics() },
		]);
		const report = mod.buildBenchmarkReport(dir);
		expect(report.counts).toEqual({
			instances: 4,
			attempts: 4,
			resolved: 1,
			unresolved: 1,
			infra_error: 1,
			not_evaluated: 1,
		});
		expect(report.resolved_rate).toBeCloseTo(1 / 2, 12);
		expect(report.resolved_rate_denominator).toBe(2);
		expect(report.schema_version).toBe(1);
	});

	test("resolved = 0: rate null, denominator 0, per-resolved null — no division by zero", async () => {
		const mod = await bench();
		const dir = makeTmpDir();
		writeOutDir(dir, [
			{
				id: "demo/p",
				verdict: "not_evaluated",
				metrics: metrics({ model_rounds_total: 10, tool_calls_total: 5, tokens: { ...metrics().tokens, total_tokens: 1000 } }),
			},
		]);
		const report = mod.buildBenchmarkReport(dir);
		expect(report.resolved_rate).toBeNull();
		expect(report.resolved_rate_denominator).toBe(0);
		expect(report.per_resolved).toEqual({ rounds: null, tool_calls: null, tokens: null });
	});
});

describe("per-resolved efficiency numerators", () => {
	test("failed-but-infra-valid attempts stay in the numerator", async () => {
		const mod = await bench();
		const dir = makeTmpDir();
		writeOutDir(dir, [
			{
				id: "demo/r",
				verdict: "resolved",
				terminated_by: "model_rounds",
				metrics: metrics({
					model_rounds_total: 100,
					primary_model_rounds: 90,
					support_model_rounds: 10,
					failed_model_attempts: 1,
					tool_calls_total: 500,
					tokens: {
						...metrics().tokens,
						total_tokens: 10_000,
						cache_read: 100,
						cache_write: 20,
						cache_metrics_available: true,
						cache_hit_rate: 0.5,
					},
					wall_seconds: 60,
				}),
			},
			{
				id: "demo/u",
				verdict: "unresolved",
				metrics: metrics({
					model_rounds_total: 50,
					primary_model_rounds: 50,
					failed_model_attempts: 1,
					tool_calls_total: 200,
					tokens: { ...metrics().tokens, total_tokens: 5_000, cache_metrics_available: true, cache_hit_rate: 0 },
					wall_seconds: 30,
				}),
			},
			{
				id: "demo/i",
				verdict: "infra_error",
				metrics: metrics({
					model_rounds_total: 400,
					primary_model_rounds: 400,
					failed_model_attempts: 1,
					tool_calls_total: 100,
					tokens: { ...metrics().tokens, total_tokens: 8_000 },
					wall_seconds: 45,
				}),
			},
			{
				id: "demo/p",
				verdict: "not_evaluated",
				terminated_by: "wall_seconds",
				metrics: metrics({
					model_rounds_total: 25,
					primary_model_rounds: 20,
					support_model_rounds: 5,
					tool_calls_total: 50,
					tokens: { ...metrics().tokens, total_tokens: 1_000 },
					wall_seconds: 90,
				}),
			},
		]);
		const report = mod.buildBenchmarkReport(dir);
		// Every attempt's consumption is in the numerator, divided by resolved=1.
		expect(report.per_resolved.rounds).toBe(575); // 100+50+400+25
		expect(report.per_resolved.tool_calls).toBe(850);
		expect(report.per_resolved.tokens).toBe(24_000);

		// Distribution stats over per-attempt totals (zeros included).
		expect(report.model_rounds.total).toBe(575);
		expect(report.model_rounds.median).toBe(75); // [25,50,100,400] -> (50+100)/2
		expect(report.model_rounds.p90).toBe(400); // nearest-rank ceil(0.9*4)=4th
		expect(report.model_rounds.primary).toBe(560);
		expect(report.model_rounds.support).toBe(15);
		expect(report.model_rounds.failed_attempts).toBe(3);
		expect(report.tool_calls.total).toBe(850);
		expect(report.tool_calls.median).toBe(150); // [50,100,200,500]
		expect(report.tool_calls.p90).toBe(500);
		expect(report.tokens.total).toBe(24_000);
		expect(report.tokens.median).toBe(6500); // [1000,5000,8000,10000]
		expect(report.tokens.p90).toBe(10_000);
		expect(report.tool_calls_per_model_round).toBeCloseTo(850 / 575, 12);

		// Budget stops are counted, and are orthogonal to verdicts.
		expect(report.budget_terminations).toEqual({
			model_rounds: 1,
			tool_calls: 0,
			total_tokens: 0,
			wall_seconds: 1,
			none: 2,
		});

		// Cache: one attempt unreported poisons availability; sums still shown.
		expect(report.cache).toEqual({
			read: 100,
			write: 20,
			hit_rate: null,
			metrics_available: false,
		});

		// Wall time is telemetry, explicitly not a ranking axis.
		expect(report.wall_time).toEqual({ total_seconds: 225, median_seconds: 52.5, p90_seconds: 90, not_ranked: true });
	});
});

describe("report shape discipline", () => {
	test("comparison keys expose everything a fair comparison requires", async () => {
		const mod = await bench();
		const dir = makeTmpDir();
		const ids = ["demo/b", "demo/a"];
		writeOutDir(
			dir,
			ids.map((id) => ({ id, verdict: "resolved", metrics: metrics() })),
		);
		const report = mod.buildBenchmarkReport(dir);
		expect(Object.keys(report.comparison_keys).sort()).toEqual([
			"budgets",
			"dataset_id",
			"dataset_revision",
			"dataset_split",
			"harness_commit",
			"instance_set_digest",
			"tool_network",
		]);
		expect(report.comparison_keys.dataset_revision).toBe("78f471bf655a3137b2e8a75af1501690ec009ec3");
		expect(report.comparison_keys.harness_commit).toBe("7a21e05772954cc81471ae19d56f436cecf43c54");
		expect(report.comparison_keys.tool_network).toBe("disabled");
		expect(report.comparison_keys.budgets).toEqual({
			model_rounds: 120,
			tool_calls: 400,
			total_tokens: 3_000_000,
			wall_seconds: 5400,
		});
		const digest = createHash("sha256")
			.update([...ids].sort().join("\n"))
			.digest("hex");
		expect(report.comparison_keys.instance_set_digest).toBe(digest);
	});

	test("no composite score exists anywhere in the top level", async () => {
		const mod = await bench();
		const dir = makeTmpDir();
		writeOutDir(dir, [{ id: "demo/r", verdict: "resolved", metrics: metrics() }]);
		const report = mod.buildBenchmarkReport(dir);
		for (const key of Object.keys(report)) {
			expect(key.toLowerCase()).not.toMatch(/score|composite|ranking/);
		}
		// Cost stays informational: it lives inside token summaries only.
		expect(report).not.toHaveProperty("cost");
	});

	test("rebuilding from the same artifacts is deterministic except generated_at", async () => {
		const mod = await bench();
		const dir = makeTmpDir();
		writeOutDir(dir, [
			{ id: "demo/r", verdict: "resolved", metrics: metrics({ model_rounds_total: 3 }) },
			{ id: "demo/u", verdict: "unresolved", metrics: metrics({ model_rounds_total: 7 }) },
		]);
		const first = mod.buildBenchmarkReport(dir);
		const second = mod.buildBenchmarkReport(dir);
		delete first.generated_at;
		delete second.generated_at;
		expect(first).toEqual(second);
	});
});
