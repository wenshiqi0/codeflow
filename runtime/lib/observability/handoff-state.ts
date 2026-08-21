/**
 * Privacy-safe handoff-state observability.
 *
 * This module is the metadata-plane boundary between Codeflow runtime and a
 * benchmark/report consumer. It projects only closed enum and attribution
 * fields from `state.json`; prose, receipts, artifacts, and evidence refs are
 * intentionally unrepresentable in the output shape.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const HANDOFF_STATE_PROJECTION_SCHEMA_VERSION = 1;

export const OBSERVABILITY_BLOCKED_REASONS = [
	"CONTEXT_BUDGET_EXCEEDED",
	"DELEGATION_ARTIFACT_MISSING",
	"EXECUTION_TIMEOUT",
	"OUTPUT_TRUNCATED",
	"PROVIDER_FAILURE",
	"USER_CANCELLED",
] as const;

export type ObservabilityBlockedReason = (typeof OBSERVABILITY_BLOCKED_REASONS)[number];
export type HandoffProjectionStatus = "open" | "running" | "done" | "blocked";
export type HandoffProjectionResult = "PASS" | "FAIL" | "BLOCKED";

export interface HandoffStateProjection {
	schema_version: 1;
	run_id: string;
	handoff_id: string;
	role: string;
	depth: number;
	status: HandoffProjectionStatus;
	result: HandoffProjectionResult | null;
	goal_id: string | null;
	lane: string | null;
	blocked_reasons: ObservabilityBlockedReason[];
	/** Count of non-enum values found in runtime blocked.reasons. */
	unknown_blocked_reasons: number;
	retry_of: string | null;
}

export interface HandoffStateScan {
	states: HandoffStateProjection[];
	unknownBlockedReasons: number;
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

const BLOCKED_REASON_SET: ReadonlySet<string> = new Set(OBSERVABILITY_BLOCKED_REASONS);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || value.length === 0) {
		throw new HandoffObservabilityError("expected a non-empty string or null");
	}
	return value;
}

/** Projects the allowlisted metadata fields; all other state fields are discarded. */
export function projectHandoffState(runId: string, value: unknown): HandoffStateProjection {
	if (!isObject(value)) throw new HandoffObservabilityError("handoff state must be an object");
	if (typeof runId !== "string" || runId.length === 0) {
		throw new HandoffObservabilityError("run_id must be a non-empty string");
	}
	const status = value.status;
	if (status !== "open" && status !== "running" && status !== "done" && status !== "blocked") {
		throw new HandoffObservabilityError(`invalid handoff status: ${String(status)}`);
	}
	const result = value.result ?? null;
	if (result !== null && result !== "PASS" && result !== "FAIL" && result !== "BLOCKED") {
		throw new HandoffObservabilityError(`invalid handoff result: ${String(result)}`);
	}
	const role = value.role;
	const depth = value.depth;
	if (typeof role !== "string" || role.length === 0) {
		throw new HandoffObservabilityError("handoff role must be a non-empty string");
	}
	if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0) {
		throw new HandoffObservabilityError("handoff depth must be a non-negative integer");
	}
	const handoffId = optionalString(value.handoff_id);
	if (handoffId === null) throw new HandoffObservabilityError("handoff_id is required");

	const blocked = isObject(value.blocked) ? value.blocked : {};
	const rawReasons = Array.isArray(blocked.reasons) ? blocked.reasons : [];
	const blockedReasons: ObservabilityBlockedReason[] = [];
	let unknownReasons = 0;
	for (const reason of rawReasons) {
		if (typeof reason === "string" && BLOCKED_REASON_SET.has(reason)) {
			blockedReasons.push(reason as ObservabilityBlockedReason);
		} else {
			unknownReasons++;
		}
	}

	return {
		schema_version: HANDOFF_STATE_PROJECTION_SCHEMA_VERSION,
		run_id: runId,
		handoff_id: handoffId,
		role,
		depth,
		status,
		result,
		goal_id: optionalString(value.goal_id),
		lane: optionalString(value.lane),
		blocked_reasons: [...new Set(blockedReasons)].sort(),
		unknown_blocked_reasons: unknownReasons,
		retry_of: optionalString(value.retry_of),
	};
}

function readStateFile(file: string, runId: string): HandoffStateProjection {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		throw new HandoffObservabilityError(`could not read handoff state ${file}: ${(error as Error).message}`);
	}
	try {
		return projectHandoffState(runId, parsed);
	} catch (error) {
		throw new HandoffObservabilityError(`${file}: ${(error as HandoffObservabilityError).message}`);
	}
}

/**
 * Bounded scan of one attempt's Codeflow runs root:
 * `<runs>/<run-id>/handoffs/<handoff-id>/state.json`.
 */
export function scanHandoffStates(runsRoot: string): HandoffStateScan {
	if (!fs.existsSync(runsRoot)) return { states: [], unknownBlockedReasons: 0 };
	const states: HandoffStateProjection[] = [];
	let unknownBlockedReasons = 0;
	for (const runEntry of fs.readdirSync(runsRoot, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		if (!runEntry.isDirectory()) continue;
		const handoffsRoot = path.join(runsRoot, runEntry.name, "handoffs");
		if (!fs.existsSync(handoffsRoot)) continue;
		for (const handoffEntry of fs.readdirSync(handoffsRoot, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (!handoffEntry.isDirectory()) continue;
			const statePath = path.join(handoffsRoot, handoffEntry.name, "state.json");
			if (!fs.existsSync(statePath)) continue;
			const state = readStateFile(statePath, runEntry.name);
			states.push(state);
			unknownBlockedReasons += state.unknown_blocked_reasons;
		}
	}
	return { states, unknownBlockedReasons };
}

function validateProjection(value: unknown, index: number): HandoffStateProjection {
	if (!isObject(value)) {
		throw new HandoffObservabilityError(`handoff projection ${index + 1} must be an object`);
	}
	const expectedKeys = new Set([
		"schema_version",
		"run_id",
		"handoff_id",
		"role",
		"depth",
		"status",
		"result",
		"goal_id",
		"lane",
		"blocked_reasons",
		"unknown_blocked_reasons",
		"retry_of",
	]);
	for (const key of Object.keys(value)) {
		if (!expectedKeys.has(key)) {
			throw new HandoffObservabilityError(`handoff projection ${index + 1}: unexpected key ${key}`);
		}
	}
	for (const key of expectedKeys) {
		if (!(key in value)) {
			throw new HandoffObservabilityError(`handoff projection ${index + 1}: missing key ${key}`);
		}
	}
	if (value.schema_version !== HANDOFF_STATE_PROJECTION_SCHEMA_VERSION) {
		throw new HandoffObservabilityError(`handoff projection ${index + 1}: unsupported schema_version`);
	}
	if (
		typeof value.unknown_blocked_reasons !== "number" ||
		!Number.isInteger(value.unknown_blocked_reasons) ||
		value.unknown_blocked_reasons < 0
	) {
		throw new HandoffObservabilityError(
			`handoff projection ${index + 1}: unknown_blocked_reasons must be a non-negative integer`,
		);
	}
	if (!Array.isArray(value.blocked_reasons)) {
		throw new HandoffObservabilityError(`handoff projection ${index + 1}: blocked_reasons must be an array`);
	}
	const projected = projectHandoffState(value.run_id as string, {
		...value,
		blocked: { reasons: value.blocked_reasons },
	});
	return {
		...projected,
		unknown_blocked_reasons: value.unknown_blocked_reasons,
	};
}

/** Reads the canonical telemetry artifact written by the benchmark runner. */
export function readHandoffStateProjections(file: string): HandoffStateProjection[] {
	let content: string;
	try {
		content = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new HandoffObservabilityError(`malformed handoff telemetry ${file}: ${(error as Error).message}`);
	}
	if (!isObject(parsed) || parsed.schema_version !== HANDOFF_STATE_PROJECTION_SCHEMA_VERSION || !Array.isArray(parsed.states)) {
		throw new HandoffObservabilityError(
			`handoff telemetry ${file} must be schema_version 1 with a states array`,
		);
	}
	return parsed.states.map((value, index) => validateProjection(value, index));
}
