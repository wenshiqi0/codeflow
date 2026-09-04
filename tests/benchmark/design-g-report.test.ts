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
import { COMMITMENT_STATE_PROJECTION_SCHEMA_VERSION } from "../../runtime/lib/observability/commitment-state";
import type { RunFactsRecord } from "../../runtime/lib/observability/run-facts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function runFact(overrides: Partial<RunFactsRecord> = {}): RunFactsRecord {
	return {
		schema_version: 3,
		task_id: "task-a",
		execution_id: "exec-root",
		commitment_id: "c_root",
		goal_id: "task-a",
		execution_rounds_elapsed: 0,
		context_utilization: { basis: "unknown" },
		prompt_shape: {
			system_prompt: { hash: "system-a", chars: 100 },
			tool_schema: { hash: "tools-a", chars: 200, count: 5 },
			worker_context: {
				hash: "context-a",
				chars: 300,
				sections: [{ kind: "task", hash: "task-a", chars: 250 }],
			},
			message_prefix: { hash: "messages-a", chars: 400 },
		},
		prefix_transition_count: 0,
		prefix_invalidation_count: 0,
		system_prompt_changed: 0,
		tool_schema_changed: 0,
		worker_context_changed: 0,
		message_prefix_invalidated: 0,
		...overrides,
	};
}

test("report exposes uniform observation metadata, actual delegation, round buckets, and summed prefix counts", () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-design-g-report-"));
	dirs.push(out);
	const observation = {
		schema_version: OBSERVATION_SCHEMA_VERSION as 3,
		intervention_flags: {
			work_commitment_claims: true,
			run_facts: true,
			collaborate_capabilities: true,
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
		attempts_per_instance: 2,
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
		schema_version: COMMITMENT_STATE_PROJECTION_SCHEMA_VERSION as 1,
		task_id: "task-a",
		commitment_id: "c_root",
		goal_id: "task-a",
		parent_commitment_id: null,
		worker_kind: "worker" as const,
		status: "completed" as const,
		receipt_id: "r_root",
		runtime_failure_reasons: [],
		unknown_runtime_failure_reasons: 0,
		has_direct_child: true,
	};
	const metrics = buildAttemptMetrics({
		usageRecords: [],
		failedModelAttempts: [],
		toolCallRecords: [],
		commitmentStates: [state],
		commitmentTelemetryAvailable: true,
		runFactsRecords: [
			runFact(),
			runFact({
				execution_rounds_elapsed: 1,
				context_utilization: { value: 0.5, basis: "pi_estimate" },
				prompt_shape: {
					...runFact().prompt_shape,
					message_prefix: { hash: "messages-b", chars: 500 },
				},
				prefix_transition_count: 1,
				prefix_invalidation_count: 1,
				message_prefix_invalidated: 1,
			}),
		],
		wallSeconds: 10,
		terminatedBy: null,
	});
	metrics.model_rounds_total = 45;
	metrics.tool_calls_by_operation = {
		source_discovery: 2,
		execute: 1,
		evidence_run: 2,
		evidence_log: 1,
		inspect: 1,
		claim: 1,
		report: 1,
		delegate: 1,
	};
	const interruptedState = {
		...state,
		commitment_id: "c_interrupted",
		status: "interrupted" as const,
		receipt_id: null,
		runtime_failure_reasons: ["OUTPUT_TRUNCATED" as const],
		has_direct_child: false,
	};
	const interruptedMetrics = buildAttemptMetrics({
		usageRecords: [],
		failedModelAttempts: [],
		toolCallRecords: [],
		commitmentStates: [interruptedState],
		commitmentTelemetryAvailable: true,
		runFactsRecords: [runFact({
			execution_id: "exec-interrupted",
			commitment_id: "c_interrupted",
		})],
		wallSeconds: 12,
		terminatedBy: null,
	});
	interruptedMetrics.model_rounds_total = 56;
	const attemptDir = path.join(out, "cases", "demo__demo", "attempts", "1");
	fs.mkdirSync(path.join(attemptDir, "telemetry"), { recursive: true });
	fs.writeFileSync(path.join(attemptDir, "telemetry", "commitments.json"), JSON.stringify({
		schema_version: COMMITMENT_STATE_PROJECTION_SCHEMA_VERSION,
		states: [state],
	}));
	const interruptedDir = path.join(out, "cases", "demo__demo", "attempts", "2");
	fs.mkdirSync(path.join(interruptedDir, "telemetry"), { recursive: true });
	fs.writeFileSync(path.join(interruptedDir, "telemetry", "commitments.json"), JSON.stringify({
		schema_version: COMMITMENT_STATE_PROJECTION_SCHEMA_VERSION,
		states: [interruptedState],
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
		}, {
			attempt: 2,
			execution_status: "infra_error",
			terminated_by: null,
			evaluation_run_id: "eval-b",
			verdict: "infra_error",
			started_at: new Date(20_000).toISOString(),
			ended_at: new Date(32_000).toISOString(),
			metrics: interruptedMetrics,
			observation,
		}],
		final_verdict: "resolved",
	}, null, 2));

	const report = buildBenchmarkReport(out);
	expect(report.prefix_cache).toMatchObject({
		prefix_transition_count: 1,
		prefix_invalidation_count: 1,
		prefix_invalidation_rate: 1,
		system_prompt_change_count: 0,
		tool_schema_change_count: 0,
		worker_context_change_count: 0,
		message_prefix_invalidation_count: 1,
		prompt_shape_metrics_available: true,
		component_chars: {
			system_prompt: [100],
			tool_schema: [200],
			worker_context: [300],
			message_prefix_min: 400,
			message_prefix_max: 500,
		},
		max_context_utilization: 0.5,
	});
	expect(report.split_economics).toMatchObject({
		spontaneous_split_eligible: 2,
		spontaneous_split_count: 1,
		spontaneous_split_rate: 0.5,
	});
	expect(report.split_economics.rounds_buckets["40+"]).toEqual({ resolved: 1, unresolved: 0, resolved_rate: 1 });
	expect(report.collaboration).toEqual({
		source_discovery_operations: 2,
		validation_operations: 4,
		integration_operations: 4,
	});
	expect(report.comparison_keys).toMatchObject({
		observation_schema_version: 3,
		intervention_flags: observation.intervention_flags,
	});
});
