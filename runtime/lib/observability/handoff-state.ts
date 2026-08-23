/** Privacy-safe projection of canonical Handoff / Receipt runtime state. */

import * as fs from "node:fs";
import { EVENT_REASONS } from "../events";
import { handoffHistory, RECEIPT_STATUSES, type ReceiptStatus } from "../handoff";
import { RunPaths } from "../paths";
import { scan } from "../wait";

export const HANDOFF_STATE_PROJECTION_SCHEMA_VERSION = 1;
export const OBSERVABILITY_RUNTIME_FAILURE_REASONS = EVENT_REASONS;
export type ObservabilityRuntimeFailureReason = (typeof EVENT_REASONS)[number];
export type HandoffProjectionStatus = "open" | "running" | "interrupted" | ReceiptStatus;

export interface HandoffStateProjection {
	schema_version: 1;
	task_id: string;
	handoff_id: string;
	goal_id: string;
	parent_handoff_id: string | null;
	worker_kind: "worker";
	status: HandoffProjectionStatus;
	receipt_id: string | null;
	runtime_failure_reasons: ObservabilityRuntimeFailureReason[];
	unknown_runtime_failure_reasons: number;
}

export interface HandoffStateScan {
	states: HandoffStateProjection[];
	unknownRuntimeFailureReasons: number;
}

export interface HandoffStateTelemetryFile {
	schema_version: 1;
	states: HandoffStateProjection[];
}

export { summarizeHandoffStates, type HandoffObservabilitySummary } from "./summary";

export class HandoffObservabilityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HandoffObservabilityError";
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function interruptedReasons(paths: RunPaths, handoffId: string): {
	reasons: ObservabilityRuntimeFailureReason[];
	unknown: number;
} | null {
	const events = scan(paths.events, 0, ["execution_interrupted"]).events
		.filter((event) => event.subject === handoffId.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
	const latest = events.at(-1);
	if (!latest) return null;
	const reasons = latest.reasons ?? [];
	return { reasons: reasons as ObservabilityRuntimeFailureReason[], unknown: 0 };
}

/** Project one canonical runtime Handoff without exposing semantic prose or Effects. */
export function projectHandoffState(paths: RunPaths, handoffId: string): HandoffStateProjection {
	const view = handoffHistory(paths).find((entry) => entry.handoff.id === handoffId);
	if (!view) throw new HandoffObservabilityError(`unknown handoff: ${handoffId}`);
	const interrupted = view.receipt === null ? interruptedReasons(paths, handoffId) : null;
	const status: HandoffProjectionStatus = view.receipt?.status
		?? (view.status === "running" ? "running" : interrupted ? "interrupted" : "open");
	return {
		schema_version: HANDOFF_STATE_PROJECTION_SCHEMA_VERSION,
		task_id: paths.runId,
		handoff_id: view.handoff.id,
		goal_id: view.handoff.goal_id,
		parent_handoff_id: view.handoff.parent_handoff_id,
		worker_kind: "worker",
		status,
		receipt_id: view.receipt?.id ?? null,
		runtime_failure_reasons: interrupted?.reasons ?? [],
		unknown_runtime_failure_reasons: interrupted?.unknown ?? 0,
	};
}

/** Scan canonical handoff and receipt documents below each Task directory. */
export function scanHandoffStates(runsRoot: string): HandoffStateScan {
	if (!fs.existsSync(runsRoot)) return { states: [], unknownRuntimeFailureReasons: 0 };
	const states: HandoffStateProjection[] = [];
	for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
		const paths = new RunPaths(runsRoot, entry.name);
		if (!fs.existsSync(paths.task)) continue;
		try {
			for (const view of handoffHistory(paths)) states.push(projectHandoffState(paths, view.handoff.id));
		} catch (error) {
			throw new HandoffObservabilityError(`${entry.name}: ${(error as Error).message}`);
		}
	}
	return {
		states,
		unknownRuntimeFailureReasons: states.reduce(
			(sum, state) => sum + state.unknown_runtime_failure_reasons,
			0,
		),
	};
}

const PROJECTION_KEYS = new Set([
	"schema_version",
	"task_id",
	"handoff_id",
	"goal_id",
	"parent_handoff_id",
	"worker_kind",
	"status",
	"receipt_id",
	"runtime_failure_reasons",
	"unknown_runtime_failure_reasons",
]);

function validateProjection(value: unknown, index: number): HandoffStateProjection {
	if (!isObject(value)) throw new HandoffObservabilityError(`handoff projection ${index + 1} must be an object`);
	for (const key of Object.keys(value)) {
		if (!PROJECTION_KEYS.has(key)) throw new HandoffObservabilityError(`handoff projection ${index + 1}: unexpected key ${key}`);
	}
	for (const key of PROJECTION_KEYS) {
		if (!(key in value)) throw new HandoffObservabilityError(`handoff projection ${index + 1}: missing key ${key}`);
	}
	if (value.schema_version !== HANDOFF_STATE_PROJECTION_SCHEMA_VERSION) {
		throw new HandoffObservabilityError(`handoff projection ${index + 1}: unsupported schema_version`);
	}
	for (const key of ["task_id", "handoff_id", "goal_id"] as const) {
		if (typeof value[key] !== "string" || value[key].length === 0) {
			throw new HandoffObservabilityError(`handoff projection ${index + 1}: ${key} must be non-empty`);
		}
	}
	for (const key of ["parent_handoff_id", "receipt_id"] as const) {
		if (value[key] !== null && (typeof value[key] !== "string" || value[key].length === 0)) {
			throw new HandoffObservabilityError(`handoff projection ${index + 1}: ${key} must be a string or null`);
		}
	}
	if (value.worker_kind !== "worker") {
		throw new HandoffObservabilityError(`handoff projection ${index + 1}: worker_kind must be worker`);
	}
	const statuses = ["open", "running", "interrupted", ...RECEIPT_STATUSES];
	if (!statuses.includes(String(value.status))) {
		throw new HandoffObservabilityError(`handoff projection ${index + 1}: invalid status ${String(value.status)}`);
	}
	if (!Array.isArray(value.runtime_failure_reasons)) {
		throw new HandoffObservabilityError(`handoff projection ${index + 1}: runtime_failure_reasons must be an array`);
	}
	for (const reason of value.runtime_failure_reasons) {
		if (!(EVENT_REASONS as readonly unknown[]).includes(reason)) {
			throw new HandoffObservabilityError(`handoff projection ${index + 1}: invalid runtime failure reason`);
		}
	}
	if (!Number.isSafeInteger(value.unknown_runtime_failure_reasons) || Number(value.unknown_runtime_failure_reasons) < 0) {
		throw new HandoffObservabilityError(`handoff projection ${index + 1}: unknown_runtime_failure_reasons must be non-negative`);
	}
	return value as unknown as HandoffStateProjection;
}

/** Read the canonical telemetry projection written by the benchmark runner. */
export function readHandoffStateProjections(file: string): HandoffStateProjection[] {
	let content: string;
	try { content = fs.readFileSync(file, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	let parsed: unknown;
	try { parsed = JSON.parse(content); }
	catch (error) { throw new HandoffObservabilityError(`malformed handoff telemetry ${file}: ${(error as Error).message}`); }
	if (!isObject(parsed) || parsed.schema_version !== HANDOFF_STATE_PROJECTION_SCHEMA_VERSION || !Array.isArray(parsed.states)) {
		throw new HandoffObservabilityError(`handoff telemetry ${file} must be schema_version 1 with a states array`);
	}
	return parsed.states.map(validateProjection);
}
