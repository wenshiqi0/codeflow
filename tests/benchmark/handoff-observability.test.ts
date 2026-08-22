/**
 * Runtime handoff-state observability and its benchmark-facing aggregation.
 *
 * The contract is metadata-only: closed enums and attribution may cross the
 * runtime/report boundary; prose, receipts, and artifact references may not.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTmpDirs, loadBenchmarkModule, makeTmpDir } from "./helpers";

afterEach(cleanupTmpDirs);

function stateFile(runsRoot: string, runId: string, handoffId: string): string {
	const file = path.join(runsRoot, runId, "handoffs", handoffId, "state.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	return file;
}

function writeRuntimeState(
	runsRoot: string,
	runId: string,
	handoffId: string,
	state: Record<string, unknown>,
): void {
	fs.writeFileSync(
		stateFile(runsRoot, runId, handoffId),
		JSON.stringify({
			schema_version: 2,
			run_id: runId,
			handoff_id: handoffId,
			role: "coder",
			depth: 1,
			goal: "secret goal prose",
			scope: ["secret/scope"],
			...state,
		}),
	);
}

function projection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema_version: 1,
		run_id: "run-1",
		handoff_id: "h00001-coder",
		role: "coder",
		depth: 1,
		status: "blocked",
		result: "BLOCKED",
		goal_id: "goal-1",
		lane: "code",
		blocked_reasons: ["PROVIDER_FAILURE"],
		unknown_blocked_reasons: 0,
		retry_of: null,
		...overrides,
	};
}

describe("handoff metadata projection", () => {
	test("projects only closed metadata and counts unknown reasons", async () => {
		const mod = await loadBenchmarkModule();
		const dir = makeTmpDir();
		writeRuntimeState(dir, "run-1", "h00001-coder", {
			status: "blocked",
			result: "BLOCKED",
			goal_id: "goal-1",
			lane: "code",
			blocked: {
				reasons: ["PROVIDER_FAILURE", "NEW_RUNTIME_REASON", "not an enum"],
				detail: "provider socket closed",
			},
			summary: "secret summary",
			receipt: "handoffs/h/receipt.json",
			artifacts: ["secret-artifact.md"],
		});

		const scan = mod.scanHandoffStates(dir);
		expect(scan.states).toHaveLength(1);
		expect(scan.unknownBlockedReasons).toBe(2);
		expect(scan.states[0]).toEqual(projection({ unknown_blocked_reasons: 2 }));
		expect(JSON.stringify(scan.states[0])).not.toContain("secret");
		expect(JSON.stringify(scan.states[0])).not.toContain("socket");
	});

	test("canonical telemetry refuses prose smuggled as an extra key", async () => {
		const mod = await loadBenchmarkModule();
		const dir = makeTmpDir();
		const file = path.join(dir, "handoff-states.json");
		fs.writeFileSync(file, JSON.stringify({ schema_version: 1, states: [projection({ summary: "secret" })] }));
		expect(() => mod.readHandoffStateProjections(file)).toThrow(/unexpected key summary/);
	});
});

describe("runner and report consume handoff observability", () => {
	test("runner writes canonical telemetry and report aggregates by reason, role, and lane", async () => {
		const mod = await loadBenchmarkModule();
		const dir = makeTmpDir();
		const outDir = path.join(dir, "benchmark-out");
		const result = await mod.runBenchmark({
			dataset: "tests/benchmark/fixtures/verified-snapshot.json",
			instances: ["demo/demo-1001"],
			outDir,
			benchmarkRunId: "bench-20260821-000000-test",
			modelNameOrPath: "fixture/model",
			driverMode: "fixture",
			codeflowCommit: "0123456789abcdef0123456789abcdef01234567",
			clock: { now: () => Date.parse("2026-08-21T00:00:00Z") },
			driver: {
				async *startAttempt(input) {
					const runsRoot = path.resolve(input.workspaceDir, "..", "codeflow-runs");
					writeRuntimeState(runsRoot, "run-inner", "h00001-coder", {
						role: "coder",
						status: "blocked",
						result: "BLOCKED",
						goal_id: "goal-1",
						lane: "code",
						blocked: { reasons: ["PROVIDER_FAILURE", "UNDOCUMENTED"], detail: "secret" },
					});
				},
			},
			evaluator: { evaluate: async () => "unresolved" },
		});

		const telemetryFile = path.join(outDir, "cases", "demo__demo-1001", "attempts", "1", "telemetry", "handoff-states.json");
		const telemetry = JSON.parse(fs.readFileSync(telemetryFile, "utf8"));
		expect(telemetry.schema_version).toBe(1);
		expect(telemetry.states).toHaveLength(1);
		expect(result.report.runtime_observability.handoffs).toMatchObject({
			total: 1,
			pass: 0,
			fail: 0,
			blocked: 1,
			nonterminal: 0,
			blocked_reasons: { PROVIDER_FAILURE: 1 },
			unknown_blocked_reasons: 1,
			redelegations: 0,
			metrics_available: true,
		});
		expect(result.report.runtime_observability.handoffs.by_role.coder.blocked_reasons).toEqual({
			PROVIDER_FAILURE: 1,
		});
		expect(result.report.runtime_observability.handoffs.by_lane.code.blocked).toBe(1);
	});

	test("old v1-style artifacts rebuild with observability unavailable", async () => {
		const mod = await loadBenchmarkModule();
		const dir = makeTmpDir();
		fs.mkdirSync(path.join(dir, "cases", "demo__a"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "benchmark-run.json"),
			JSON.stringify({
				schema_version: 1,
				benchmark_run_id: "bench-20260821-000000-old",
				created_at: "2026-08-21T00:00:00Z",
				dataset: {
					dataset_id: "SWE-bench/SWE-bench_Verified",
					split: "test",
					revision: "78f471bf655a3137b2e8a75af1501690ec009ec3",
					source: "local-snapshot",
					instance_count: 1,
				},
				instances: { allowlist: null, selected: ["demo/a"] },
				harness: { commit: "7a21e05772954cc81471ae19d56f436cecf43c54" },
				codeflowCommit: "0123456789abcdef0123456789abcdef01234567",
				model_config: "test",
				concurrency: 1,
				tool_network: "disabled",
				model_provider_network: "disabled",
				budgets: {
					defaults: { model_rounds: 1, tool_calls: 1, fresh_tokens: 1, total_tokens: 1, wall_seconds: 1 },
					overrides: null,
					effective: { model_rounds: 1, tool_calls: 1, fresh_tokens: 1, total_tokens: 1, wall_seconds: 1 },
				},
				driver_mode: "fixture",
			}),
		);
		fs.writeFileSync(
			path.join(dir, "predictions.jsonl"),
			`${JSON.stringify({ instance_id: "demo/a", model_name_or_path: "m", model_patch: "" })}\n`,
		);
		fs.writeFileSync(
			path.join(dir, "cases", "demo__a", "case.json"),
			JSON.stringify({
				schema_version: 1,
				instance_id: "demo/a",
				final_verdict: "unresolved",
				attempts: [
					{
						attempt: 1,
						execution_status: "completed",
						terminated_by: null,
						evaluation_run_id: "old--a--1",
						verdict: "unresolved",
						started_at: "2026-08-21T00:00:00Z",
						ended_at: "2026-08-21T00:00:01Z",
						metrics: {
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
							wall_seconds: 1,
							terminated_by: null,
						},
					},
				],
			}),
		);
		const report = mod.buildBenchmarkReport(dir);
		expect(report.runtime_observability.handoffs.metrics_available).toBe(false);
		expect(report.runtime_observability.handoffs.total).toBe(0);
		const telemetryDir = path.join(dir, "cases", "demo__a", "attempts", "1", "telemetry");
		fs.mkdirSync(telemetryDir, { recursive: true });
		fs.writeFileSync(path.join(telemetryDir, "handoff-states.json"), JSON.stringify({ schema_version: 1, states: [] }));
		expect(mod.buildBenchmarkReport(dir).runtime_observability.handoffs).toMatchObject({
			total: 0,
			metrics_available: true,
		});
	});
});
