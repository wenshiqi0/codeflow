/**
 * Shared on-disk artifact shapes for one benchmark run (contract §3).
 *
 * Every JSON document carries `schema_version`; JSON documents use the
 * existing atomic-replace primitive (`writeJsonAtomic` in runtime/lib/paths)
 * and ledgers are append-only with complete lines, so an interrupted run can
 * never parse half a document.
 */

import type { BenchmarkBudgets, BudgetName, ConsumptionMetricName } from "./budgets";
import type { AttemptMetrics } from "./metrics";
import type { BenchmarkVerdict } from "./driver";

export const BENCHMARK_MANIFEST_SCHEMA_VERSION = 5;
export const BENCHMARK_CASE_SCHEMA_VERSION = 3;
export const OBSERVATION_SCHEMA_VERSION = 1;

export interface InterventionFlags {
	delivery_obligations: boolean;
	decomposition_record: boolean;
	handoff_spawn: boolean;
	run_facts: boolean;
	midcourse_handoff_text: boolean;
}

export interface ObservationConfig {
	schema_version: 1;
	intervention_flags: InterventionFlags;
	request_named_split: boolean;
}

export interface BenchmarkManifest {
	schema_version: 5;
	benchmark_run_id: string;
	created_at: string;
	dataset: {
		dataset_id: string;
		split: string;
		/** Exact 40-hex sha; never a moving alias. */
		revision: string;
		source: "local-snapshot" | "hub";
		instance_count: number;
	};
	instances: {
		/** The allowlist exactly as provided, or null for "all". */
		allowlist: string[] | null;
		/** Selected ids in dataset order. */
		selected: string[];
	};
	harness: { commit: string };
	/** Exact 40-hex sha of the Codeflow checkout that ran the benchmark. */
	codeflow_commit: string;
	model_config: string;
	concurrency: number;
	/** Official single-attempt reports use 1; >1 is pilot/diagnostic only. */
	attempts_per_instance: number;
	tool_network: "disabled";
	model_provider_network: "disabled" | "required";
	termination_budgets: {
		defaults: BenchmarkBudgets;
		overrides: Partial<BenchmarkBudgets> | null;
		effective: BenchmarkBudgets;
	};
	consumption_metrics: {
		axes: ConsumptionMetricName[];
	};
	driver_mode: "fixture" | "codeflow";
	observation: ObservationConfig;
}

export interface CaseAttemptRecord {
	attempt: number;
	execution_status: "completed" | "infra_error";
	terminated_by: BudgetName | null;
	evaluation_run_id: string;
	verdict: BenchmarkVerdict;
	started_at: string;
	ended_at: string;
	metrics: AttemptMetrics;
	observation: ObservationConfig;
	/** Present in case files written by hygiene-aware runners. */
	patch_hygiene?: {
		stripped_binary_paths: string[];
	};
}

export interface CaseFile {
	schema_version: 3;
	instance_id: string;
	attempts: CaseAttemptRecord[];
	final_verdict: BenchmarkVerdict;
}
