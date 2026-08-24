import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	BENCHMARK_CASE_SCHEMA_VERSION,
	BENCHMARK_MANIFEST_SCHEMA_VERSION,
	OBSERVATION_SCHEMA_VERSION,
} from "../../benchmark/lib/artifacts";
import { buildAttemptMetrics } from "../../benchmark/lib/metrics";
import { appendPredictionEntry } from "../../benchmark/lib/predictions";
import { buildBenchmarkReport } from "../../benchmark/lib/report";
import { HANDOFF_STATE_PROJECTION_SCHEMA_VERSION } from "../../runtime/lib/observability/handoff-state";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

test("report exposes uniform observation metadata, verified declarations, round buckets, and summed prefix counts", () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-design-g-report-"));
	dirs.push(out);
	const observation = {
		schema_version: OBSERVATION_SCHEMA_VERSION as 1,
		intervention_flags: {
			delivery_obligations: true,
			decomposition_record: true,
			handoff_spawn: true,
			run_facts: true,
			midcourse_handoff_text: true,
		},
		request_named_split: false,
	};
	fs.writeFileSync(path.join(out, "benchmark-run.json"), JSON.stringify({
		schema_version: BENCHMARK_MANIFEST_SCHEMA_VERSION,
		benchmark_run_id: "bench-design-g",
		created_at: new Date(0).toISOString(),
		dataset: { dataset_id: "demo", split: "test", revision: "a".repeat(40), source: "local-snapshot", instance_count: 1 },
		instances: { allowlist: ["demo/demo"], selected: ["demo/demo"] },
		harness: { commit: "b".repeat(40) },
		codeflow_commit: "c".repeat(40),
		model_config: "model-a",
		concurrency: 1,
		attempts_per_instance: 1,
		tool_network: "disabled",
		model_provider_network: "disabled",
		termination_budgets: {
			defaults: { wall_seconds: 100 },
			overrides: null,
			effective: { wall_seconds: 100 },
		},
		consumption_metrics: { axes: ["model_rounds", "tool_calls", "fresh_tokens", "total_tokens"] },
		driver_mode: "fixture",
		observation,
	}, null, 2));
	appendPredictionEntry(out, { instance_id: "demo/demo", model_name_or_path: "model-a", model_patch: "" });

	const state = {
		schema_version: HANDOFF_STATE_PROJECTION_SCHEMA_VERSION as 2,
		task_id: "task-a",
		handoff_id: "h_root",
		goal_id: "task-a",
		parent_handoff_id: null,
		worker_kind: "worker" as const,
		status: "completed" as const,
		receipt_id: "r_root",
		runtime_failure_reasons: [],
		unknown_runtime_failure_reasons: 0,
		decomposition: "split" as const,
		decomposition_mismatch: false,
		has_direct_child: true,
		obligation_regression: "met" as const,
		obligation_reproduction: "exempt" as const,
		obligation_consumers: "missing" as const,
	};
	const metrics = buildAttemptMetrics({
		usageRecords: [],
		failedModelAttempts: [],
		toolCallRecords: [],
		handoffStates: [state],
		handoffTelemetryAvailable: true,
		runFactsRecords: [
			{
				schema_version: 1,
				task_id: "task-a",
				handoff_id: "h_root",
				goal_id: "task-a",
				execution_rounds_elapsed: 0,
				context_utilization: { basis: "unknown" },
				prefix_transition_count: 0,
				prefix_invalidation_count: 0,
			},
			{
				schema_version: 1,
				task_id: "task-a",
				handoff_id: "h_root",
				goal_id: "task-a",
				execution_rounds_elapsed: 1,
				context_utilization: { value: 0.5, basis: "pi_estimate" },
				prefix_transition_count: 1,
				prefix_invalidation_count: 1,
			},
		],
		wallSeconds: 10,
		terminatedBy: null,
	});
	metrics.model_rounds_total = 45;
	const attemptDir = path.join(out, "cases", "demo__demo", "attempts", "1");
	fs.mkdirSync(path.join(attemptDir, "telemetry"), { recursive: true });
	fs.writeFileSync(path.join(attemptDir, "telemetry", "handoffs.json"), JSON.stringify({
		schema_version: HANDOFF_STATE_PROJECTION_SCHEMA_VERSION,
		states: [state],
	}));
	fs.writeFileSync(path.join(out, "cases", "demo__demo", "case.json"), JSON.stringify({
		schema_version: BENCHMARK_CASE_SCHEMA_VERSION,
		instance_id: "demo/demo",
		attempts: [{
			attempt: 1,
			execution_status: "completed",
			terminated_by: null,
			evaluation_run_id: "eval-a",
			verdict: "resolved",
			started_at: new Date(0).toISOString(),
			ended_at: new Date(10_000).toISOString(),
			metrics,
			observation,
		}],
		final_verdict: "resolved",
	}, null, 2));

	const report = buildBenchmarkReport(out);
	expect(report.prefix_cache).toMatchObject({
		prefix_transition_count: 1,
		prefix_invalidation_count: 1,
		prefix_invalidation_rate: 1,
	});
	expect(report.split_economics).toMatchObject({
		spontaneous_split_eligible: 1,
		spontaneous_split_count: 1,
		spontaneous_split_rate: 1,
		decomposition_mismatch_rate: 0,
	});
	expect(report.split_economics.verified_declarations.obligations.consumers).toMatchObject({ eligible: 1, missing: 1 });
	expect(report.split_economics.rounds_buckets["40+"]).toEqual({ resolved: 1, unresolved: 0, resolved_rate: 1 });
	expect(report.comparison_keys).toMatchObject({
		observation_schema_version: 1,
		intervention_flags: observation.intervention_flags,
	});
});
