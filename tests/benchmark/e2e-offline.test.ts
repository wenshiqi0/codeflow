/**
 * Offline end-to-end chain (design §4, §10, §13.2): the real CLI drives the
 * full loop with the fixture dataset, the fake Codeflow driver, and the fake
 * evaluator — no network, no Docker, no model calls.
 *
 * run -> workspace -> git-diff patch -> predictions.jsonl -> evaluation run id
 * -> verdict merge -> report.json, with a manifest that pins exactly what was
 * run, artifacts that never appear half-written, and a wall stop that still
 * submit the patch.
 *
 * Expected numbers are derived from tests/benchmark/fixtures (see its README):
 *  - attempts per instance: 1001 resolved, 1002 unresolved, 1003 infra_error,
 *    1004 not_evaluated, 1005 resolved with large token consumption.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	CANARY_PREFIX,
	casePath,
	cleanupTmpDirs,
	FIXTURE_DRIVER_DIR,
	listFiles,
	makeTmpDir,
	readJson,
	readJsonl,
	runCodeflow,
	SNAPSHOT,
	writeInstancesFile,
} from "./helpers";

let outDir: string;
let runResult: ReturnType<typeof runCodeflow>;

function benchmarkRun(out: string, extra: string[] = []): ReturnType<typeof runCodeflow> {
	return runCodeflow([
		"benchmark",
		"run",
		"--dataset",
		SNAPSHOT,
		"--fixture",
		FIXTURE_DRIVER_DIR,
		"--out",
		out,
		...extra,
	]);
}

beforeAll(() => {
	outDir = makeTmpDir("codeflow-bench-e2e-");
	runResult = benchmarkRun(outDir);
}, 120_000);

afterAll(cleanupTmpDirs);

function artifactRelMissing(rel: string): string {
	return (
		`missing ${rel}: the fixture benchmark run failed ` +
		`(exit ${runResult.exitCode}) — stderr: ${runResult.stderr.slice(0, 400)}`
	);
}

/** Artifact reads fail pointing at the failed run, not with a bare ENOENT. */
function artifact(rel: string): string {
	const full = path.join(outDir, rel);
	if (!fs.existsSync(full)) throw new Error(artifactRelMissing(rel));
	return full;
}

/** Read one case.json with the same failed-run diagnostic. */
function caseFileOf(id: string): any {
	return readJson(artifact(path.join("cases", id.replace(/\//g, "__"), "case.json")));
}

describe("the chain completes offline through the real CLI", () => {
	test("exit 0 — the fixture chain needs no provider, docker, or network", () => {
		expect(runResult.exitCode).toBe(0);
	});

	test("the artifact set matches the contract layout", () => {
		for (const rel of [
			"benchmark-run.json",
			"predictions.jsonl",
			"report.json",
			"cases/demo__demo-1001/case.json",
			"cases/demo__demo-1001/attempts/1/usage.jsonl",
			"cases/demo__demo-1001/attempts/1/tool-calls.jsonl",
			"cases/demo__demo-1005/attempts/1/workspace/fix.py",
		]) {
			expect(fs.existsSync(path.join(outDir, rel))).toBe(true);
		}
	});

	test("every JSON artifact carries schema_version and parses whole", () => {
		const files = listFiles(outDir);
		// Guard against a vacuous pass: a run that wrote nothing has nothing to check.
		expect(files.filter((rel) => rel.endsWith(".json")).length).toBeGreaterThan(0);
			for (const rel of files) {
				if (rel.endsWith(".json")) {
					expect([1, 2, 3]).toContain(readJson(artifact(rel)).schema_version);
			} else if (rel.endsWith(".jsonl")) {
				// Throws on any half line: append-only writers must write whole lines.
				expect(readJsonl(artifact(rel)).length).toBeGreaterThan(0);
			}
		}
		expect(listFiles(outDir).some((rel) => rel.endsWith(".tmp"))).toBe(false);
	});
});

describe("the manifest pins what actually ran", () => {
	test("dataset identity, harness, and codeflow commits are exact", () => {
		const manifest = readJson(artifact("benchmark-run.json"));
		expect(manifest.schema_version).toBe(3);
		expect(manifest.dataset.dataset_id).toBe("SWE-bench/SWE-bench_Verified");
		expect(manifest.dataset.split).toBe("test");
		expect(manifest.dataset.revision).toBe("78f471bf655a3137b2e8a75af1501690ec009ec3");
		expect(manifest.dataset.revision).toMatch(/^[0-9a-f]{40}$/);
		expect(manifest.harness.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(manifest.codeflow_commit).toMatch(/^[0-9a-f]{40}$/);
	});

	test("concurrency, networks, budgets, and driver mode are recorded", () => {
		const manifest = readJson(artifact("benchmark-run.json"));
		expect(manifest.concurrency).toBe(1);
		// The two networks are declared SEPARATELY (design §4): two distinct
		// manifest keys, independently valued — not one derived field.
		expect(Object.keys(manifest)).toContain("tool_network");
		expect(Object.keys(manifest)).toContain("model_provider_network");
		expect(manifest.tool_network).toBe("disabled");
		expect(manifest.model_provider_network).toBe("disabled");
		expect(manifest.driver_mode).toBe("fixture");
		expect(manifest.termination_budgets.defaults).toEqual({ wall_seconds: 5400 });
		expect(manifest.termination_budgets.effective).toEqual({ wall_seconds: 5400 });
		expect(manifest.termination_budgets.overrides).toBe(null);
		expect(manifest.consumption_metrics.axes).toEqual([
			"model_rounds",
			"tool_calls",
			"fresh_tokens",
			"total_tokens",
		]);
		expect(manifest.instances.selected).toEqual([
			"demo/demo-1001",
			"demo/demo-1002",
			"demo/demo-1003",
			"demo/demo-1004",
			"demo/demo-1005",
		]);
	});
});

describe("predictions satisfy the official field contract", () => {
	test("one complete line per attempt, dataset order, exact keys", () => {
		const predictions = readJsonl(artifact("predictions.jsonl"));
		expect(predictions.map((p: any) => p.instance_id)).toEqual([
			"demo/demo-1001",
			"demo/demo-1002",
			"demo/demo-1003",
			"demo/demo-1004",
			"demo/demo-1005",
		]);
		for (const p of predictions) {
			expect(Object.keys(p).sort()).toEqual(["instance_id", "model_name_or_path", "model_patch"]);
			expect(p.model_name_or_path).toBe("fixture/fake-model");
		}
	});

	test("patches are the extracted workspace diffs, including after a wall stop", () => {
		const predictions = Object.fromEntries(
			readJsonl(artifact("predictions.jsonl")).map((p: any) => [p.instance_id, p]),
		);
		expect(predictions["demo/demo-1001"].model_patch).toContain("FIXED_1001");
		expect(predictions["demo/demo-1002"].model_patch).toContain("FIXED_1002");
		expect(predictions["demo/demo-1003"].model_patch).toContain("# partial");
		expect(predictions["demo/demo-1004"].model_patch).toBe("");
		// 1005 exceeds the former token cap but now completes its script.
		expect(predictions["demo/demo-1005"].model_patch).toContain("FIXED_1005");
	});
});

describe("verdict merge", () => {
	function attempt(id: string): any {
		const file = path.join(casePath(outDir, id), "case.json");
		if (!fs.existsSync(file)) throw new Error(artifactRelMissing(`cases/${id}/case.json`));
		return readJson(file).attempts[0];
	}


	test("official-verdict classifications land per instance", () => {
		expect(attempt("demo/demo-1001").verdict).toBe("resolved");
		expect(attempt("demo/demo-1002").verdict).toBe("unresolved");
		expect(attempt("demo/demo-1003").verdict).toBe("infra_error");
		expect(attempt("demo/demo-1003").execution_status).toBe("infra_error");
		expect(attempt("demo/demo-1004").verdict).toBe("not_evaluated");
		expect(attempt("demo/demo-1005").verdict).toBe("resolved");
	});

	test("demo-1005 exceeds the former token cap without termination", () => {
		const record = attempt("demo/demo-1005");
		expect(record.terminated_by).toBe(null);
		expect(record.verdict).toBe("resolved");
		expect(record.metrics.model_rounds_total).toBe(4);
		expect(record.metrics.tokens.total_tokens).toBe(3_401_200);
	});

	test("each attempt gets its own evaluation run id, namespaced by the benchmark run", () => {
		const manifest = readJson(artifact("benchmark-run.json"));
		const ids = ["demo/demo-1001", "demo/demo-1002", "demo/demo-1003", "demo/demo-1004", "demo/demo-1005"].map(
			(id) => attempt(id).evaluation_run_id,
		);
		expect(new Set(ids).size).toBe(5);
		for (const id of ids) expect(id).toContain(manifest.benchmark_run_id);
		expect(attempt("demo/demo-1001").evaluation_run_id).toContain("demo__demo-1001--a1");
	});
});

describe("attempt ledgers", () => {
	test("usage rows equal completed rounds; failed provider attempts are separate", () => {
		const caseFile = caseFileOf("demo/demo-1001");
		const attempt = caseFile.attempts[0];
		const usageRows = readJsonl(
			path.join(casePath(outDir, "demo/demo-1001"), "attempts", "1", "usage.jsonl"),
		);
		expect(caseFile.schema_version).toBe(1);
		expect(usageRows).toHaveLength(5);
		expect(attempt.metrics.model_rounds_total).toBe(5);
		expect(attempt.metrics.primary_model_rounds).toBe(3);
		expect(attempt.metrics.support_model_rounds).toBe(2);
		expect(attempt.metrics.failed_model_attempts).toBe(1);
	});

	test("tool-call counts classify success, failure, rejection, and incompleteness", () => {
		const attempt = caseFileOf("demo/demo-1001").attempts[0];
		expect(attempt.metrics.tool_calls_total).toBe(4);
		expect(attempt.metrics.tool_call_counts).toEqual({
			requested: 4,
			completed: 3,
			succeeded: 1,
			failed: 1,
			rejected: 1,
			incomplete: 1,
		});
		expect(attempt.metrics.tool_calls_by_tool).toEqual({ bash: 2, read: 1, write: 1 });
	});

	test("a multi-command bash call stays one call: demo-1002 counts 3 calls for 2 rounds", () => {
		const attempt = caseFileOf("demo/demo-1002").attempts[0];
		expect(attempt.metrics.model_rounds_total).toBe(2);
		expect(attempt.metrics.tool_calls_total).toBe(3);
		expect(attempt.metrics.tool_calls_per_model_round).toBeCloseTo(1.5, 12);
	});

	test("explicit zeros keep cache metrics available with the token-weighted rate", () => {
		const attempt = caseFileOf("demo/demo-1002").attempts[0];
		expect(attempt.metrics.tokens.cache_metrics_available).toBe(true);
		expect(attempt.metrics.tokens.cache_hit_rate).toBeCloseTo(90 / 1100, 12);
		// demo-1001 has one unreported round: unavailable, null rate.
		const mixed = caseFileOf("demo/demo-1001").attempts[0];
		expect(mixed.metrics.tokens.cache_metrics_available).toBe(false);
		expect(mixed.metrics.tokens.cache_hit_rate).toBeNull();
	});
});

describe("report.json", () => {
	const report = () => readJson(artifact("report.json"));

	test("counts expose every classification; denominator is valid verdicts only", () => {
		expect(report().counts).toEqual({
			instances: 5,
			attempts: 5,
			resolved: 2,
			unresolved: 1,
			infra_error: 1,
			not_evaluated: 1,
		});
		expect(report().resolved_rate).toBeCloseTo(2 / 3, 12);
		expect(report().resolved_rate_denominator).toBe(3);
	});

	test("efficiency aggregates match the fixture arithmetic", () => {
		expect(report().budget_terminations).toEqual({
			wall_seconds: 0,
			none: 5,
		});
		expect(report().model_rounds.total).toBe(13);
		expect(report().model_rounds.median).toBe(2);
		expect(report().model_rounds.p90).toBe(5);
		expect(report().model_rounds.primary).toBe(11);
		expect(report().model_rounds.support).toBe(2);
		expect(report().model_rounds.failed_attempts).toBe(1);
		expect(report().tool_calls.total).toBe(14);
		expect(report().tool_calls.median).toBe(3);
		expect(report().tool_calls.p90).toBe(6);
		expect(report().tokens.total).toBe(3_403_625);
		expect(report().tokens.median).toBe(700);
		expect(report().tokens.p90).toBe(3_401_200);
		expect(report().per_resolved.rounds).toBeCloseTo(13 / 2, 12);
		expect(report().per_resolved.tokens).toBeCloseTo(3_403_625 / 2, 6);
		expect(report().tool_calls_per_model_round).toBeCloseTo(14 / 13, 12);
	});

	test("cache aggregate is unavailable while any attempt is unreported", () => {
		expect(report().cache).toEqual({
			read: 3_400_120,
			write: 5,
			fresh_input_tokens: 3_010,
			fresh_tokens: null,
			prompt_tokens: 3_403_135,
			hit_rate: null,
			metrics_available: false,
			per_attempt_hit_rate: { median: 9 / 110, p90: 0.9997059688326962 },
		});
	});

	test("breakdowns by role, model, and tool; wall time is not_ranked; no score", () => {
		expect(report().breakdowns.by_role.coder.model_rounds).toBe(9);
		expect(report().breakdowns.by_role.tester.model_rounds).toBe(1);
		expect(report().breakdowns.by_model["fixture/fixture-coder"].model_rounds).toBe(9);
		expect(report().breakdowns.by_tool).toEqual({ bash: 9, read: 3, write: 2 });
		expect(report().wall_time.not_ranked).toBe(true);
		for (const key of Object.keys(report())) {
			expect(key.toLowerCase()).not.toMatch(/score|composite/);
		}
		expect(report().comparison_keys.dataset_revision).toBe(
			"78f471bf655a3137b2e8a75af1501690ec009ec3",
		);
	});
});

describe("leakage through the CLI path", () => {
	test("no evaluator-only canary reaches any artifact", () => {
		const files = listFiles(outDir);
		// Never vacuous: an empty out dir would make the scan pass without testing.
		expect(files.filter((rel) => rel.endsWith(".json") || rel.endsWith(".jsonl")).length).toBeGreaterThan(
			0,
		);
		for (const rel of files) {
			const content = fs.readFileSync(path.join(outDir, rel), "utf8");
			expect(`${rel}:${content}`).not.toContain(CANARY_PREFIX);
		}
	});
});

describe("instance allowlist and concurrency are honored", () => {
	test("only allowlisted instances run, in dataset order, with the given concurrency", () => {
		const dir = makeTmpDir();
		const result = benchmarkRun(dir, [
			"--instances",
			writeInstancesFile(["demo/demo-1002", "demo/demo-1001"]), // deliberately out of order
			"--concurrency",
			"2",
		]);
		expect(result.exitCode).toBe(0);
		const manifest = readJson(path.join(dir, "benchmark-run.json"));
		expect(manifest.instances.allowlist).toEqual(["demo/demo-1002", "demo/demo-1001"]);
		expect(manifest.instances.selected).toEqual(["demo/demo-1001", "demo/demo-1002"]);
		expect(manifest.concurrency).toBe(2);
		const cases = fs.readdirSync(path.join(dir, "cases")).sort();
		expect(cases).toEqual(["demo__demo-1001", "demo__demo-1002"]);
		const report = readJson(path.join(dir, "report.json"));
		expect(report.counts).toMatchObject({ instances: 2, resolved: 1, unresolved: 1 });
	});
});

describe("wall override stops deterministically and still submits the patch", () => {
	function stopRun(budget: string): { attempt: any; manifest: any; predictions: any[] } {
		const dir = makeTmpDir();
		const result = benchmarkRun(dir, [
			"--instances",
			writeInstancesFile(["demo/demo-1005"]),
			"--budget",
			budget,
		]);
		expect(result.exitCode).toBe(0);
		return {
			attempt: readJson(path.join(dir, "cases", "demo__demo-1005", "case.json")).attempts[0],
			manifest: readJson(path.join(dir, "benchmark-run.json")),
			predictions: readJsonl(path.join(dir, "predictions.jsonl")),
		};
	}

	test("wall-time cap stops via the simulated clock after the crossing round", () => {
		const { attempt, manifest } = stopRun("wall-seconds=600");
		expect(attempt.terminated_by).toBe("wall_seconds");
		expect(attempt.metrics.model_rounds_total).toBe(1);
		expect(attempt.metrics.wall_seconds).toBeGreaterThanOrEqual(600);
		expect(attempt.verdict).toBe("resolved");
		expect(manifest.termination_budgets.effective).toEqual({ wall_seconds: 600 });
		expect(manifest.termination_budgets.overrides).toEqual({ wall_seconds: 600 });
	});
});

describe("report rebuild needs no model, driver, or evaluator", () => {
	test("benchmark report regenerates identical aggregates from existing artifacts", () => {
		const before = readJson(artifact("report.json"));
		fs.rmSync(path.join(outDir, "report.json"));
		const result = runCodeflow(["benchmark", "report", "--run", outDir]);
		expect(result.exitCode).toBe(0);
		const after = readJson(artifact("report.json"));
		expect(after.counts).toEqual(before.counts);
		expect(after.resolved_rate).toBe(before.resolved_rate);
		expect(after.per_resolved).toEqual(before.per_resolved);
		expect(after.budget_terminations).toEqual(before.budget_terminations);
	});
});

describe("evaluation run ids differ across benchmark runs", () => {
	test("a second run of the same instance cannot reuse the first run's evaluation cache", () => {
		const firstFile = path.join(casePath(outDir, "demo/demo-1005"), "case.json");
		if (!fs.existsSync(firstFile)) throw new Error(artifactRelMissing("demo/demo-1005"));
		const first = readJson(firstFile).attempts[0].evaluation_run_id;
		const dir = makeTmpDir();
		const result = benchmarkRun(dir, ["--instances", writeInstancesFile(["demo/demo-1005"])]);
		expect(result.exitCode).toBe(0);
		const second = readJson(path.join(casePath(dir, "demo/demo-1005"), "case.json")).attempts[0]
			.evaluation_run_id;
		expect(second).not.toBe(first);
	});
});
