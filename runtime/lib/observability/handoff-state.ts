/** Privacy-safe projection of canonical Handoff / Receipt runtime state. */

import * as fs from "node:fs";
import * as path from "node:path";
import { EVENT_REASONS } from "../events";
import { handoffHistory, RECEIPT_STATUSES, type ReceiptRecord, type ReceiptStatus } from "../handoff";
import { RunPaths } from "../paths";
import { scan } from "../wait";

export const HANDOFF_STATE_PROJECTION_SCHEMA_VERSION = 2;
export const OBSERVABILITY_RUNTIME_FAILURE_REASONS = EVENT_REASONS;
export type ObservabilityRuntimeFailureReason = (typeof EVENT_REASONS)[number];
export type HandoffProjectionStatus = "open" | "running" | "interrupted" | ReceiptStatus;
export type ObligationProjection = "met" | "exempt" | "missing" | "malformed";
export type DecompositionProjection = "split" | "solo" | "missing" | "malformed";

export interface HandoffStateProjection {
	schema_version: 2;
	task_id: string;
	handoff_id: string;
	goal_id: string;
	parent_handoff_id: string | null;
	worker_kind: "worker";
	status: HandoffProjectionStatus;
	receipt_id: string | null;
	runtime_failure_reasons: ObservabilityRuntimeFailureReason[];
	unknown_runtime_failure_reasons: number;
	decomposition: DecompositionProjection | null;
	decomposition_mismatch: boolean | null;
	has_direct_child: boolean | null;
	obligation_regression: ObligationProjection | null;
	obligation_reproduction: ObligationProjection | null;
	obligation_consumers: ObligationProjection | null;
}

export interface HandoffStateScan {
	states: HandoffStateProjection[];
	unknownRuntimeFailureReasons: number;
}

export interface HandoffStateTelemetryFile {
	schema_version: 2;
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

function decisionRows(receipt: ReceiptRecord, key: string): string[] {
	const prefix = `${key}:`.toLowerCase();
	return receipt.decisions.filter((decision) => decision.trim().toLowerCase().startsWith(prefix));
}

function evidenceFileIsValid(paths: RunPaths, receipt: ReceiptRecord, reference: string): boolean {
	if (!path.isAbsolute(reference) || reference.split(path.sep).includes("..")) return false;
	if (!receipt.effects.some((effect) => "file" in effect && effect.file === reference)) return false;
	try {
		const root = fs.realpathSync(paths.evidence);
		const file = fs.realpathSync(reference);
		const relative = path.relative(root, file);
		return fs.statSync(file).isFile() && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	} catch {
		return false;
	}
}

function projectObligation(
	paths: RunPaths,
	receipt: ReceiptRecord,
	name: "regression" | "reproduction" | "consumers",
): ObligationProjection {
	const key = `obligation.${name}`;
	const rows = decisionRows(receipt, key);
	if (rows.length === 0) return "missing";
	if (rows.length !== 1 || /[\r\n]/.test(rows[0])) return "malformed";
	const match = rows[0].trim().match(new RegExp(`^${key.replace(".", "\\.")}:\\s*(met|exempt)\\s+—\\s+(.+)$`, "i"));
	if (!match || match[2].trim() === "") return "malformed";
	if (match[1].toLowerCase() === "exempt") return "exempt";
	const value = match[2].trim();
	if (name === "consumers") {
		return /^[^,\s:]+:[^,\s]+(?:\s*,\s*[^,\s:]+:[^,\s]+)*$/.test(value) ? "met" : "malformed";
	}
	return evidenceFileIsValid(paths, receipt, value) ? "met" : "malformed";
}

function projectDecomposition(receipt: ReceiptRecord): DecompositionProjection {
	const rows = decisionRows(receipt, "decomposition");
	if (rows.length === 0) return "missing";
	if (rows.length !== 1 || /[\r\n]/.test(rows[0])) return "malformed";
	const match = rows[0].trim().match(/^decomposition:\s*(split|solo)\s+—\s+(.+)$/i);
	return match && match[2].trim() ? match[1].toLowerCase() as "split" | "solo" : "malformed";
}

/** Project one canonical runtime Handoff without exposing semantic prose or Effects. */
export function projectHandoffState(paths: RunPaths, handoffId: string): HandoffStateProjection {
	const history = handoffHistory(paths);
	const view = history.find((entry) => entry.handoff.id === handoffId);
	if (!view) throw new HandoffObservabilityError(`unknown handoff: ${handoffId}`);
	const interrupted = view.folded.terminal === null ? interruptedReasons(paths, handoffId) : null;
	const status: HandoffProjectionStatus = view.folded.terminal?.status
		?? (view.status === "running" ? "running" : interrupted ? "interrupted" : "open");
	const isRoot = view.handoff.goal_id === paths.runId && view.handoff.parent_handoff_id === null;
	const decomposition = isRoot && view.folded.terminal ? projectDecomposition(view.folded.terminal) : null;
	const hasDirectChild = history.some((entry) => entry.handoff.parent_handoff_id === view.handoff.id);
	const obligationEligible = view.folded.terminal !== null
		&& (isRoot || view.folded.terminal.status === "completed" || view.folded.terminal.status === "partial");
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
		decomposition,
		decomposition_mismatch:
			decomposition === "split" ? !hasDirectChild
				: decomposition === "solo" ? hasDirectChild
					: null,
		has_direct_child: isRoot && view.folded.terminal ? hasDirectChild : null,
		obligation_regression: obligationEligible ? projectObligation(paths, view.folded.terminal!, "regression") : null,
		obligation_reproduction: obligationEligible ? projectObligation(paths, view.folded.terminal!, "reproduction") : null,
		obligation_consumers: obligationEligible ? projectObligation(paths, view.folded.terminal!, "consumers") : null,
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
	"decomposition",
	"decomposition_mismatch",
	"has_direct_child",
	"obligation_regression",
	"obligation_reproduction",
	"obligation_consumers",
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
	const obligationStates = ["met", "exempt", "missing", "malformed", null];
	for (const key of ["obligation_regression", "obligation_reproduction", "obligation_consumers"] as const) {
		if (!obligationStates.includes(value[key] as never)) {
			throw new HandoffObservabilityError(`handoff projection ${index + 1}: invalid ${key}`);
		}
	}
	if (!["split", "solo", "missing", "malformed", null].includes(value.decomposition as never)) {
		throw new HandoffObservabilityError(`handoff projection ${index + 1}: invalid decomposition`);
	}
	if (value.decomposition_mismatch !== null && typeof value.decomposition_mismatch !== "boolean") {
		throw new HandoffObservabilityError(`handoff projection ${index + 1}: invalid decomposition_mismatch`);
	}
	if (value.has_direct_child !== null && typeof value.has_direct_child !== "boolean") {
		throw new HandoffObservabilityError(`handoff projection ${index + 1}: invalid has_direct_child`);
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
		throw new HandoffObservabilityError(`handoff telemetry ${file} must use the current schema with a states array`);
	}
	return parsed.states.map(validateProjection);
}
