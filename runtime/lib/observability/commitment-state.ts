/** Privacy-safe projection derived from canonical Commitment and Receipt state. */

import * as fs from "node:fs";
import { EVENT_REASONS } from "../events";
import { commitmentHistory, RECEIPT_STATUSES, type ReceiptStatus } from "../commitment";
import { RunPaths } from "../paths";
import { scan } from "../wait";

export const COMMITMENT_STATE_PROJECTION_SCHEMA_VERSION = 1;
export const OBSERVABILITY_RUNTIME_FAILURE_REASONS = EVENT_REASONS;
export type ObservabilityRuntimeFailureReason = (typeof EVENT_REASONS)[number];
export type CommitmentProjectionStatus = "open" | "running" | "interrupted" | ReceiptStatus;

export interface CommitmentStateProjection {
	schema_version: 1;
	task_id: string;
	commitment_id: string;
	goal_id: string;
	parent_commitment_id: string | null;
	worker_kind: "worker";
	status: CommitmentProjectionStatus;
	receipt_id: string | null;
	runtime_failure_reasons: ObservabilityRuntimeFailureReason[];
	unknown_runtime_failure_reasons: number;
	has_direct_child: boolean;
}

export interface CommitmentStateScan {
	states: CommitmentStateProjection[];
	unknownRuntimeFailureReasons: number;
}

export interface CommitmentStateTelemetryFile {
	schema_version: 1;
	states: CommitmentStateProjection[];
}

export { summarizeCommitmentStates, type CommitmentObservabilitySummary } from "./summary";

export class CommitmentObservabilityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommitmentObservabilityError";
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function interruptedReasons(paths: RunPaths, commitmentId: string): {
	reasons: ObservabilityRuntimeFailureReason[];
	unknown: number;
} | null {
	const events = scan(paths.events, 0, ["execution_interrupted"]).events
		.filter((event) => event.subject === commitmentId.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
	const latest = events.at(-1);
	if (!latest) return null;
	return { reasons: (latest.reasons ?? []) as ObservabilityRuntimeFailureReason[], unknown: 0 };
}

/** Project actual topology and lifecycle; no model-authored metric declarations exist. */
export function projectCommitmentState(paths: RunPaths, commitmentId: string): CommitmentStateProjection {
	const history = commitmentHistory(paths);
	const view = history.find((entry) => entry.commitment.id === commitmentId);
	if (!view) throw new CommitmentObservabilityError(`unknown commitment: ${commitmentId}`);
	const interrupted = view.folded.terminal === null ? interruptedReasons(paths, commitmentId) : null;
	return {
		schema_version: COMMITMENT_STATE_PROJECTION_SCHEMA_VERSION,
		task_id: paths.runId,
		commitment_id: view.commitment.id,
		goal_id: view.commitment.goal_id,
		parent_commitment_id: view.commitment.parent_commitment_id,
		worker_kind: "worker",
		status: view.folded.terminal?.status
			?? (view.status === "running" ? "running" : interrupted ? "interrupted" : "open"),
		receipt_id: view.folded.terminal?.id ?? null,
		runtime_failure_reasons: interrupted?.reasons ?? [],
		unknown_runtime_failure_reasons: interrupted?.unknown ?? 0,
		has_direct_child: history.some((entry) => entry.commitment.parent_commitment_id === view.commitment.id),
	};
}

export function scanCommitmentStates(runsRoot: string): CommitmentStateScan {
	if (!fs.existsSync(runsRoot)) return { states: [], unknownRuntimeFailureReasons: 0 };
	const states: CommitmentStateProjection[] = [];
	for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
		const paths = new RunPaths(runsRoot, entry.name);
		if (!fs.existsSync(paths.task)) continue;
		try {
			for (const view of commitmentHistory(paths)) states.push(projectCommitmentState(paths, view.commitment.id));
		} catch (error) {
			throw new CommitmentObservabilityError(`${entry.name}: ${(error as Error).message}`);
		}
	}
	return {
		states,
		unknownRuntimeFailureReasons: states.reduce((sum, state) => sum + state.unknown_runtime_failure_reasons, 0),
	};
}

const PROJECTION_KEYS = new Set([
	"schema_version", "task_id", "commitment_id", "goal_id", "parent_commitment_id",
	"worker_kind", "status", "receipt_id", "runtime_failure_reasons",
	"unknown_runtime_failure_reasons", "has_direct_child",
]);

function validateProjection(value: unknown, index: number): CommitmentStateProjection {
	if (!isObject(value)) throw new CommitmentObservabilityError(`commitment projection ${index + 1} must be an object`);
	for (const key of Object.keys(value)) {
		if (!PROJECTION_KEYS.has(key)) throw new CommitmentObservabilityError(`commitment projection ${index + 1}: unexpected key ${key}`);
	}
	for (const key of PROJECTION_KEYS) {
		if (!(key in value)) throw new CommitmentObservabilityError(`commitment projection ${index + 1}: missing key ${key}`);
	}
	if (value.schema_version !== COMMITMENT_STATE_PROJECTION_SCHEMA_VERSION) {
		throw new CommitmentObservabilityError(`commitment projection ${index + 1}: unsupported schema_version`);
	}
	for (const key of ["task_id", "commitment_id", "goal_id"] as const) {
		if (typeof value[key] !== "string" || value[key].length === 0) {
			throw new CommitmentObservabilityError(`commitment projection ${index + 1}: ${key} must be non-empty`);
		}
	}
	for (const key of ["parent_commitment_id", "receipt_id"] as const) {
		if (value[key] !== null && (typeof value[key] !== "string" || value[key].length === 0)) {
			throw new CommitmentObservabilityError(`commitment projection ${index + 1}: ${key} must be a string or null`);
		}
	}
	if (value.worker_kind !== "worker") throw new CommitmentObservabilityError(`commitment projection ${index + 1}: worker_kind must be worker`);
	if (!["open", "running", "interrupted", ...RECEIPT_STATUSES].includes(String(value.status))) {
		throw new CommitmentObservabilityError(`commitment projection ${index + 1}: invalid status ${String(value.status)}`);
	}
	if (!Array.isArray(value.runtime_failure_reasons)) {
		throw new CommitmentObservabilityError(`commitment projection ${index + 1}: runtime_failure_reasons must be an array`);
	}
	for (const reason of value.runtime_failure_reasons) {
		if (!(EVENT_REASONS as readonly unknown[]).includes(reason)) {
			throw new CommitmentObservabilityError(`commitment projection ${index + 1}: invalid runtime failure reason`);
		}
	}
	if (!Number.isSafeInteger(value.unknown_runtime_failure_reasons) || Number(value.unknown_runtime_failure_reasons) < 0) {
		throw new CommitmentObservabilityError(`commitment projection ${index + 1}: unknown_runtime_failure_reasons must be non-negative`);
	}
	if (typeof value.has_direct_child !== "boolean") {
		throw new CommitmentObservabilityError(`commitment projection ${index + 1}: has_direct_child must be boolean`);
	}
	return value as unknown as CommitmentStateProjection;
}

export function readCommitmentStateProjections(file: string): CommitmentStateProjection[] {
	let content: string;
	try { content = fs.readFileSync(file, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	let parsed: unknown;
	try { parsed = JSON.parse(content); }
	catch (error) { throw new CommitmentObservabilityError(`malformed commitment telemetry ${file}: ${(error as Error).message}`); }
	if (!isObject(parsed) || parsed.schema_version !== COMMITMENT_STATE_PROJECTION_SCHEMA_VERSION || !Array.isArray(parsed.states)) {
		throw new CommitmentObservabilityError(`commitment telemetry ${file} must use the current schema with a states array`);
	}
	return parsed.states.map(validateProjection);
}
