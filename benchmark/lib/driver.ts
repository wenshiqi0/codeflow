/**
 * Driver and evaluator seams (contract §1.7).
 *
 * The runner drives an attempt by pulling events from an injected
 * `BenchmarkCodeflowDriver`. This is the ONLY place a fake Codeflow (fixture
 * mode) substitutes for the real one, and the ONLY data a Codeflow run may
 * see for an instance is the allowlist projection inside
 * {@link DriverAttemptInput} — nothing else, by type.
 */

import type { BenchmarkBudgets, BenchmarkClock } from "./budgets";
import type { FailedModelAttempt } from "./metrics";
import type { ModelVisibleInstance } from "./dataset";
import type { AttemptUsage } from "../../runtime/lib/observability/model-usage";

export interface DriverToolCall {
	call_id: string;
	tool: string;
	status: "succeeded" | "failed" | "rejected" | "incomplete";
	/** Source-clock request timestamp; required for credible B1 timing. */
	requested_at?: string;
	/** Source-clock terminal timestamp; null only for incomplete calls. */
	result_at?: string | null;
}

export interface DriverRound {
	/** Source assistant-response timestamp when the runtime observed one. */
	at?: string;
	/** Runtime-attributed run id when the source ledger observed one. */
	run_id?: string | null;
	role: string;
	provider: string;
	model: string;
	depth?: number | null;
	turn?: number | null;
	handoff_id?: string | null;
	goal_id?: string | null;
	lane?: string | null;
	usage: AttemptUsage;
	/** Source provider request start boundary when observed. */
	request_started_at?: string | null;
	/** Tool calls emitted by this one response. */
	tool_calls?: DriverToolCall[];
	/** Simulated wall-clock advance for this round; the driver applies it to the injected clock. */
	advance_ms?: number;
}

export type DriverEvent =
	| { type: "round"; round: DriverRound }
	| { type: "failed_model_attempt"; attempt: Omit<FailedModelAttempt, "schema_version" | "at">; advance_ms?: number }
	| { type: "workspace_write"; path: string; content: string }
	| { type: "budget_stop"; budget: "wall_seconds" }
	| { type: "infra_error"; error_class: string }
	| DriverToolCallsEvent;

/**
 * Real-mode instrumentation variant: tool calls that terminated between
 * rounds, attributed to the role AND provider/model that issued them — the
 * emitting context recorded on the staging row, never role→model inference.
 * Fixture drivers attach a response's calls to its round event (the round
 * carries the attribution); the real Codeflow driver streams each call as it
 * terminates so tool-call budgets supervise the live process without waiting
 * for the next model response.
 */
export interface DriverToolCallsEvent {
	type: "tool_calls";
	role: string;
	/** Provider of the assistant response that emitted these calls. */
	provider: string;
	/** Model of the assistant response that emitted these calls. */
	model: string;
	handoff_id?: string | null;
	goal_id?: string | null;
	lane?: string | null;
	/** Calls that reached a terminal status (or "incomplete" at stream end). */
	calls: DriverToolCall[];
}

/** The ONLY data a Codeflow run may see for an instance. */
export interface DriverAttemptInput {
	/** The allowlist projection — nothing else. */
	instance: ModelVisibleInstance;
	workspaceDir: string;
	budgets: BenchmarkBudgets;
	/** 1-based. */
	attempt: number;
	modelConfig: string;
	clock: BenchmarkClock;
	/** Absolute attempt deadline; process drivers enforce it even during event silence. */
	wallDeadlineMs: number;
}

export interface BenchmarkCodeflowDriver {
	startAttempt(input: DriverAttemptInput): AsyncIterable<DriverEvent>;
}

export interface PredictionEntry {
	instance_id: string;
	model_name_or_path: string;
	model_patch: string;
}

export type BenchmarkVerdict = "resolved" | "unresolved" | "infra_error" | "not_evaluated";

export interface BenchmarkEvaluator {
	evaluate(request: {
		prediction: PredictionEntry;
		instanceId: string;
		evaluationRunId: string;
		/**
		 * File holding the attempt's prediction with exactly the official
		 * keys (the real-mode harness reads a file, not the object). Fixture
		 * evaluators ignore it.
		 */
		predictionsFile?: string;
	}): Promise<BenchmarkVerdict>;
}
