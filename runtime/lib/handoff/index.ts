/**
 * Mechanical state layer for codeflow handoffs.
 *
 * A handoff is one unit of work moved from a delegator to a receiver. The
 * delegator writes the body (semantic plane); this module owns every state
 * change and every state query (mechanical plane):
 *
 * ```text
 * open -> running -> done(PASS|FAIL)
 *                 \-> blocked(reason)
 * ```
 *
 * Nothing here decides what to delegate or interprets why something failed.
 * Conversely, no model may write `state.json`, an event file, or a sentinel by
 * hand: state that depends on a model remembering to write it fails silently
 * and unrecoverably, so every transition hangs on a CLI subcommand instead.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { appendFacts, FactError, ledgerPath, type FactRecord } from "../facts";
import { deliverEvent, MAX_SUBJECT_CHARS, type DeliveredEvent } from "../events";
import { nowIso, readJson, RunPaths, slug, writeJsonAtomic } from "../paths";
import { assertResumeStopped, ResumeError } from "../resume";
import { nextSeq } from "../seq";

export const SCHEMA_VERSION = 2;

/**
 * The single top-level blocked enum. Free-text prose is not an acceptable
 * failure report: the outer loop switches on these, so a reason that cannot
 * be matched is a reason nobody acts on.
 */
export const BLOCKED_REASONS = [
	"CONTEXT_BUDGET_EXCEEDED",
	"DELEGATION_ARTIFACT_MISSING",
	"OUTPUT_TRUNCATED",
	"PROVIDER_FAILURE",
	"USER_CANCELLED",
] as const;

export type BlockedReason = (typeof BLOCKED_REASONS)[number];

/** Reasons that carry the nested budget detail structure. */
const BUDGET_REASONS: readonly string[] = ["CONTEXT_BUDGET_EXCEEDED"];

export const TERMINAL_STATUSES = ["PASS", "FAIL", "BLOCKED"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

const FAILURE_CLASSES = [
	"EXPECTED_FAIL",
	"UNEXPECTED_PASS",
	"RUNNER_BLOCKED",
	"POST_IMPLEMENTATION_FAIL",
	"UNCERTAIN",
] as const;

/** An excerpt longer than this is spilled to evidence/ and replaced by a ref. */
const ERROR_EXCERPT_LIMIT = 2000;

/** Registry titles are one line; a longer Goal triggers async compression. */
export const TITLE_BUDGET = 80;

const DEFAULT_STALE_SECONDS = 600;

/**
 * Fields a role must supply. `verify` carries more because its receipt is
 * the run's only execution evidence: a verdict without the command and exit
 * code cannot be audited.
 */
const RECEIPT_REQUIRED_BY_ROLE: Record<string, readonly string[]> = {
	"verify": ["status", "command", "exit_code"],
};
const RECEIPT_REQUIRED_BASE: readonly string[] = ["status"];

const RECEIPT_FIELD_TYPES: Record<string, "string" | "number" | "boolean" | "array"> = {
	next_owner: "string",
	error_excerpt: "string",
	diagnosis: "string",
	command: "string",
	reproduction: "string",
	failed_checks: "array",
	exit_code: "number",
	expected_red: "boolean",
	facts: "array",
};

const GOAL_PATTERN = /^\s*(?:[-*]\s*)?(?:#+\s*)?Goal\s*:\s*(.+?)\s*$/i;
const GOAL_HEADING = /^\s*#+\s*Goal\s*$/i;
const SCOPE_PATTERN = /^\s*(?:[-*]\s*)?(?:#+\s*)?Scope\s*:\s*(.+?)\s*$/i;
const GOAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const GOAL_LANE_PATTERN = /^(?:test|code|verify)$/;

/** A mechanical rejection: illegal transition, bad schema, missing fact. */
export class CliError extends Error {}

export interface HandoffState {
	schema_version: number;
	run_id: string;
	handoff_id: string;
	role: string;
	depth: number;
	status: "open" | "running" | "done" | "blocked";
	goal: string;
	scope: string[];
	goal_id?: string;
	lane?: "test" | "code" | "verify";
	lineage: {
		parent_handoff_id: string | null;
		parent_run_id: string | null;
		split_scope: string | null;
	};
	opened_at: string;
	scope_conflicts: string[];
	started_at?: string;
	finished_at?: string;
	summary?: string;
	result?: TerminalStatus;
	blocked?: Record<string, unknown>;
	receipt?: string;
	artifacts?: string[];
	evidence_refs?: string[];
	pid?: number;
	age_seconds?: number;
	stale?: boolean;
}

// --- parsing --------------------------------------------------------------

export function parseGoal(body: string): string {
	const lines = body.split("\n");
	for (const [index, line] of lines.entries()) {
		const match = GOAL_PATTERN.exec(line);
		if (match) return match[1].trim();
		if (GOAL_HEADING.test(line)) {
			for (const follow of lines.slice(index + 1)) {
				if (follow.trim()) return follow.trim().replace(/^[-*]+/, "").trim();
			}
		}
	}
	return "";
}

export function parseScope(body: string): string[] {
	for (const line of body.split("\n")) {
		const match = SCOPE_PATTERN.exec(line);
		if (!match) continue;
		const scope: string[] = [];
		for (const raw of match[1].split(/[,\s]+/)) {
			// Trailing punctuation is prose; a leading dot is part of the path.
			const token = raw
				.trim()
				.replace(/^[`"'()[\]]+|[`"'()[\]]+$/g, "")
				.replace(/[.,;:]+$/, "");
			if (!token) continue;
			if (token.includes("/") || token.includes(".")) scope.push(token);
		}
		return scope;
	}
	return [];
}

// --- state access ---------------------------------------------------------

function loadStates(paths: RunPaths, onlyActive = false): HandoffState[] {
	const directory = onlyActive ? paths.active : paths.handoffs;
	if (!fs.existsSync(directory)) return [];
	let ids: string[];
	try {
		ids = fs
			.readdirSync(directory, { withFileTypes: true })
			.filter((entry) => (onlyActive ? true : entry.isDirectory()))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
	const states: HandoffState[] = [];
	for (const id of ids) {
		const file = paths.statePath(id);
		if (!fs.existsSync(file)) continue;
		try {
			states.push(readJson<HandoffState>(file));
		} catch {
			// A malformed state file is skipped: one damaged handoff must not
			// make the whole board unreadable.
		}
	}
	return states;
}

function requireState(paths: RunPaths, handoffId: string): HandoffState {
	const file = paths.statePath(handoffId);
	if (!fs.existsSync(file)) {
		throw new CliError(`unknown handoff: ${handoffId} (no ${file})`);
	}
	return readJson<HandoffState>(file);
}

function staleSeconds(): number {
	const raw = process.env.CODEFLOW_HANDOFF_TIMEOUT_SECONDS;
	const value = raw ? Number.parseInt(raw, 10) : NaN;
	return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_STALE_SECONDS;
}

/**
 * Annotate an in-flight handoff with its age.
 *
 * `stale` is an age crossing a threshold, never a verdict. A model reasoning
 * for ten minutes and a hung one look identical from here, so this must not
 * be read as failure.
 */
function decorateAge(state: HandoffState): HandoffState {
	const started = state.started_at || state.opened_at;
	if (!["open", "running"].includes(state.status) || !started) return state;
	const parsed = Date.parse(started);
	if (Number.isNaN(parsed)) return state;
	const age = Math.floor((Date.now() - parsed) / 1000);
	state.age_seconds = Math.max(0, age);
	state.stale = state.age_seconds > staleSeconds();
	return state;
}

function titleFor(paths: RunPaths, state: HandoffState): string {
	const compressed = paths.titlePath(state.handoff_id);
	if (fs.existsSync(compressed)) {
		try {
			const first = fs.readFileSync(compressed, "utf-8").trim().split("\n")[0];
			if (first?.trim()) return first.trim().slice(0, TITLE_BUDGET);
		} catch {
			// Fall through to the goal.
		}
	}
	const goal = state.goal || "";
	if (goal.length > TITLE_BUDGET) {
		return goal.slice(0, TITLE_BUDGET - 1).trimEnd() + "\u2026";
	}
	return goal;
}

// --- events ---------------------------------------------------------------

function emitRunEvent(
	paths: RunPaths,
	kind: string,
	status: string,
	payload: Record<string, unknown>,
): DeliveredEvent {
	deliverEvent({
		stagingDir: paths.tmp,
		targetDir: paths.events,
		counterPath: paths.eventSeq,
		subject: paths.runId,
		kind,
		status,
		payload,
	});
	// Run-level events also reach the shared spool so an outer loop can find
	// runs it did not start.
	return deliverEvent({
		stagingDir: path.join(paths.spool, "tmp"),
		targetDir: paths.spool,
		counterPath: path.join(paths.spool, ".events.seq"),
		subject: paths.runId,
		kind,
		status,
		payload: { ...payload, run_id: paths.runId },
	});
}

function emitHandoffEvent(
	paths: RunPaths,
	handoffId: string,
	kind: string,
	status: string,
	payload: Record<string, unknown>,
): DeliveredEvent {
	return deliverEvent({
		stagingDir: paths.tmp,
		targetDir: paths.events,
		counterPath: paths.eventSeq,
		subject: handoffId,
		kind,
		status,
		payload: { ...payload, run_id: paths.runId },
	});
}

// --- receipts -------------------------------------------------------------

function validateEntry(
	entry: unknown,
	role: string,
	index: number,
	paths: RunPaths,
	handoffId: string,
	spills: string[],
): Record<string, unknown> {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		throw new CliError(`receipt entry ${index} must be a JSON object`);
	}
	const record = entry as Record<string, unknown>;

	const required = RECEIPT_REQUIRED_BY_ROLE[role] ?? RECEIPT_REQUIRED_BASE;
	const missing = required.filter((field) => !(field in record));
	if (missing.length > 0) {
		throw new CliError(
			`receipt entry ${index} for role ${role} is missing required field(s): ${missing.join(", ")}`,
		);
	}

	if (!(TERMINAL_STATUSES as readonly unknown[]).includes(record.status)) {
		throw new CliError(
			`receipt entry ${index} status must be one of ${TERMINAL_STATUSES.join(", ")}, ` +
				`got ${JSON.stringify(record.status)}`,
		);
	}

	for (const [field, expected] of Object.entries(RECEIPT_FIELD_TYPES)) {
		if (!(field in record) || record[field] === null) continue;
		const value = record[field];
		const ok =
			expected === "array"
				? Array.isArray(value)
				: expected === "number"
					? typeof value === "number" && Number.isInteger(value)
					: typeof value === expected;
		if (!ok) {
			throw new CliError(
				`receipt entry ${index} field ${field} must be ${expected}, got ${
					Array.isArray(value) ? "array" : typeof value
				}`,
			);
		}
	}

	if (role === "verify" && "failure_class" in record) {
		const failureClass = record.failure_class;
		if (
			typeof failureClass !== "string" ||
			!(FAILURE_CLASSES as readonly string[]).includes(failureClass)
		) {
			throw new CliError(
				`receipt entry ${index} failure_class must be one of ${FAILURE_CLASSES.join(", ")}`,
			);
		}
		if (failureClass === "EXPECTED_FAIL" && record.expected_red !== true) {
			throw new CliError(
				`receipt entry ${index} EXPECTED_FAIL requires expected_red: true`,
			);
		}
		if (record.expected_red === true && failureClass !== "EXPECTED_FAIL") {
			throw new CliError(
				`receipt entry ${index} expected_red: true requires failure_class EXPECTED_FAIL`,
			);
		}
	}

	// A giant excerpt would push the useful fields out of a reader's context,
	// so spill the body to evidence/ and keep a reference.
	const excerpt = record.error_excerpt;
	if (typeof excerpt === "string" && excerpt.length > ERROR_EXCERPT_LIMIT) {
		const relative = path.join("evidence", paths.runId, `${handoffId}-${index}-error.txt`);
		const target = path.join(paths.runsRoot, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, excerpt, "utf-8");
		record.error_excerpt = excerpt.slice(0, ERROR_EXCERPT_LIMIT - 1) + "\u2026";
		record.error_excerpt_ref = relative;
		spills.push(relative);
	}

	return record;
}

function validateReceipt(
	file: string,
	role: string,
	status: string,
	paths: RunPaths,
	handoffId: string,
): { receipt: Record<string, unknown>; spills: string[] } {
	if (!fs.existsSync(file)) {
		throw new CliError(`receipt file not found: ${file}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch (error) {
		throw new CliError(
			`receipt is not valid JSON (${(error as Error).message}); prose is not a receipt`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new CliError("receipt must be a JSON object");
	}
	let receipt = parsed as Record<string, unknown>;
	if (!("status" in receipt)) {
		throw new CliError("receipt is missing required field: status");
	}
	if (receipt.status !== status) {
		throw new CliError(
			`receipt status ${JSON.stringify(receipt.status)} contradicts the declared ` +
				`handoff status ${JSON.stringify(status)}`,
		);
	}

	const spills: string[] = [];
	const entries = receipt.receipts;
	if ("receipts" in receipt && !Array.isArray(entries)) {
		throw new CliError("batch receipt field receipts must be an array");
	}
	if (Array.isArray(entries)) {
		if (entries.length === 0) {
			throw new CliError("a batch receipt must contain at least one entry");
		}
		const validated = entries.map((entry, index) =>
			validateEntry(entry, role, index, paths, handoffId, spills),
		);
		const aggregateStatus = validated.every((entry) => entry.status === "PASS")
			? "PASS"
			: validated.some((entry) => entry.status === "BLOCKED")
				? "BLOCKED"
				: "FAIL";
		if (receipt.status !== aggregateStatus) {
			throw new CliError(
				`batch receipt status ${JSON.stringify(receipt.status)} contradicts entry aggregate ` +
					JSON.stringify(aggregateStatus),
			);
		}
		receipt.receipts = validated;
	} else {
		receipt = validateEntry(receipt, role, 0, paths, handoffId, spills);
	}
	return { receipt, spills };
}

// --- commands -------------------------------------------------------------

export interface OpenOptions {
	role: string;
	body: string;
	depth?: number;
	parentId?: string | null;
	parentRunId?: string | null;
	splitScope?: string | null;
	title?: string | null;
	scope?: string[];
	goalId?: string;
	lane?: "test" | "code" | "verify";
}

export interface OpenResult {
	run_id: string;
	handoff_id: string;
	role: string;
	depth: number;
	status: string;
	dir: string;
	handoff_md: string;
	state: string;
	receipt: string;
	scope: string[];
	goal_id?: string;
	lane?: "test" | "code" | "verify";
	scope_conflicts: string[];
	warning?: string;
}

export function openHandoff(paths: RunPaths, options: OpenOptions): OpenResult {
	if (!options.body.trim()) {
		throw new CliError(
			"a handoff needs a body: pass --body-file <path> or --body-file - " +
				"with the write-handoff structure on stdin",
		);
	}

	const goal = parseGoal(options.body);
	const scope = options.scope?.length ? options.scope : parseScope(options.body);
	const depth = options.depth ?? (options.parentId ? 1 : 0);
	if (options.goalId && !GOAL_ID_PATTERN.test(options.goalId)) {
		throw new CliError(`invalid goal id: ${options.goalId}`);
	}
	if (options.lane && !GOAL_LANE_PATTERN.test(options.lane)) {
		throw new CliError(`invalid goal lane: ${options.lane}`);
	}
	if (Boolean(options.goalId) !== Boolean(options.lane)) {
		throw new CliError("goalId and lane must be provided together");
	}

	// Two active handoffs editing the same file produce a diff nobody
	// authored. Record the overlap rather than refusing: serializing is a
	// planning decision, not a mechanical one.
	const heldBy = new Map<string, string>();
	for (const state of loadStates(paths, true)) {
		for (const entry of state.scope ?? []) {
			if (!heldBy.has(entry)) heldBy.set(entry, state.handoff_id);
		}
	}
	const conflicts = scope.filter((entry) => heldBy.has(entry)).sort();

	const seq = nextSeq(paths.handoffSeq);
	const handoffId = `h${String(seq).padStart(5, "0")}-${slug(options.role)}`.slice(
		0,
		MAX_SUBJECT_CHARS,
	);
	const directory = paths.handoffDir(handoffId);
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, "handoff.md"), options.body, "utf-8");

	const state: HandoffState = {
		schema_version: SCHEMA_VERSION,
		run_id: paths.runId,
		handoff_id: handoffId,
		role: options.role,
		depth,
		status: "open",
		goal,
		scope,
		...(options.goalId ? { goal_id: options.goalId } : {}),
		...(options.lane ? { lane: options.lane } : {}),
		lineage: {
			parent_handoff_id: options.parentId ?? null,
			parent_run_id: options.parentRunId ?? (options.parentId ? paths.runId : null),
			split_scope: options.splitScope ?? null,
		},
		opened_at: nowIso(),
		scope_conflicts: conflicts,
	};
	writeJsonAtomic(paths.statePath(handoffId), state);

	fs.mkdirSync(paths.active, { recursive: true });
	fs.writeFileSync(path.join(paths.active, handoffId), "", "utf-8");

	if (options.title) {
		fs.writeFileSync(
			paths.titlePath(handoffId),
			options.title.trim().slice(0, TITLE_BUDGET) + "\n",
			"utf-8",
		);
	}

	emitHandoffEvent(paths, handoffId, "handoff_opened", "OPEN", {
		role: options.role,
		depth,
		ref: `handoffs/${handoffId}/state.json`,
		...(options.goalId ? { goal_id: options.goalId } : {}),
		...(options.lane ? { lane: options.lane } : {}),
	});

	const result: OpenResult = {
		run_id: paths.runId,
		handoff_id: handoffId,
		role: options.role,
		depth,
		status: "open",
		dir: directory,
		handoff_md: path.join(directory, "handoff.md"),
		state: paths.statePath(handoffId),
		receipt: paths.receiptPath(handoffId),
	scope,
	...(options.goalId ? { goal_id: options.goalId } : {}),
	...(options.lane ? { lane: options.lane } : {}),
	scope_conflicts: conflicts,
	};
	if (conflicts.length > 0) {
		result.warning =
			"scope overlaps an active handoff: " +
			conflicts.map((entry) => `${entry} (held by ${heldBy.get(entry)})`).join(", ");
	}
	return result;
}

export function startHandoff(
	paths: RunPaths,
	handoffId: string,
	pid?: number,
): { handoff_id: string; status: string } {
	const state = requireState(paths, handoffId);
	if (state.status === "done" || state.status === "blocked") {
		throw new CliError(
			`handoff ${handoffId} is already ${state.status}; ` +
				"starting a terminal handoff is an illegal transition",
		);
	}
	if (state.status !== "running") {
		state.status = "running";
		state.started_at = nowIso();
	}
	if (pid !== undefined) state.pid = pid;
	writeJsonAtomic(paths.statePath(handoffId), state);
	return { handoff_id: handoffId, status: "running" };
}

export interface FinishOptions {
	handoffId: string;
	status: TerminalStatus;
	summary: string;
	receipt?: string | null;
	artifacts?: string[];
	blockedReasons?: string[];
	detail?: string | null;
	budget?: {
		limit?: number;
		used?: number;
		remaining?: number;
		protectedComponent?: string;
		requiredAction?: string;
		largestSources?: unknown;
		sourceRefs?: unknown;
	};
}

export interface FinishResult {
	run_id: string;
	handoff_id: string;
	status: string;
	state: string;
	receipt: string | null;
	facts_recorded: string[];
}

export function finishHandoff(paths: RunPaths, options: FinishOptions): FinishResult {
	const { handoffId } = options;
	const state = requireState(paths, handoffId);

	if (state.status === "done" || state.status === "blocked") {
		throw new CliError(
			`handoff ${handoffId} is already ${state.status}; a terminal receipt is immutable`,
		);
	}

	const reasons = options.blockedReasons ?? [];
	if (options.status === "BLOCKED" && reasons.length === 0) {
		throw new CliError(
			"BLOCKED requires at least one --blocked-reason from: " + BLOCKED_REASONS.join(", "),
		);
	}
	if (options.status !== "BLOCKED" && reasons.length > 0) {
		throw new CliError("--blocked-reason is only valid with --status BLOCKED");
	}
	for (const reason of reasons) {
		if (!(BLOCKED_REASONS as readonly string[]).includes(reason)) {
			throw new CliError(
				`unknown blocked reason: ${reason}; expected one of ${BLOCKED_REASONS.join(", ")}`,
			);
		}
	}

	// A delegated handoff reports through a validated artifact, never through
	// prose. BLOCKED is exempt: the reason enum is the receipt.
	if (options.status !== "BLOCKED" && !options.receipt && (state.depth ?? 0) > 0) {
		throw new CliError(
			`--receipt is required to finish delegated handoff ${handoffId} as ${options.status}`,
		);
	}

	const artifacts: string[] = [];
	for (const entry of options.artifacts ?? []) {
		try {
			const artifact = fs.statSync(entry);
			if (!artifact.isFile() || artifact.size === 0) {
				throw new CliError(`declared artifact is not a non-empty file: ${entry}`);
			}
		} catch (error) {
			if (error instanceof CliError) throw error;
			throw new CliError(`declared artifact does not exist: ${entry}`);
		}
		artifacts.push(entry);
	}

	let receipt: Record<string, unknown> | null = null;
	let spills: string[] = [];
	let recordedFacts: FactRecord[] = [];

	if (options.receipt) {
		const validated = validateReceipt(
			options.receipt,
			state.role,
			options.status,
			paths,
			handoffId,
		);
		receipt = validated.receipt;
		spills = validated.spills;

		// Shared facts are a side effect of a validated receipt, never a
		// separate model-driven write. This runs before the state transition
		// so an unverifiable claim fails the finish loudly rather than
		// leaving a ledger nobody can trust.
		try {
			recordedFacts = appendFacts(
				ledgerPath(paths.runDir),
				receipt.facts,
				state.role,
				handoffId,
			);
		} catch (error) {
			if (error instanceof FactError) {
				throw new CliError(`receipt facts rejected: ${error.message}`);
			}
			throw error;
		}
	}

	if (receipt !== null) {
		writeJsonAtomic(paths.receiptPath(handoffId), receipt);
	}

	state.summary = options.summary;
	state.finished_at = nowIso();
	if (options.status === "BLOCKED") {
		const blocked: Record<string, unknown> = {
			reason: reasons[0],
			reasons: [...reasons],
		};
		if (options.detail) blocked.detail = options.detail;
		if (reasons.some((reason) => BUDGET_REASONS.includes(reason))) {
			blocked.budget_failure = buildBudgetFailure(options.budget ?? {});
		}
		state.status = "blocked";
		state.blocked = blocked;
	} else {
		state.status = "done";
		state.result = options.status;
	}
	if (receipt !== null) state.receipt = `handoffs/${handoffId}/receipt.json`;
	if (spills.length > 0) state.evidence_refs = spills;
	if (artifacts.length > 0) state.artifacts = artifacts;
	writeJsonAtomic(paths.statePath(handoffId), state);

	const sentinel = path.join(paths.active, handoffId);
	if (fs.existsSync(sentinel)) fs.rmSync(sentinel);

	for (const artifact of artifacts) {
		emitHandoffEvent(paths, handoffId, "artifact_written", "WRITTEN", { ref: artifact });
	}

	const payload: Record<string, unknown> = {
		ref: `handoffs/${handoffId}/state.json`,
		role: state.role,
		summary: options.summary,
	};
	if (state.goal_id) payload.goal_id = state.goal_id;
	if (state.lane) payload.lane = state.lane;
	if (receipt !== null) payload.receipt_ref = `handoffs/${handoffId}/receipt.json`;
	if (options.status === "BLOCKED") payload.reasons = [...reasons];
	emitHandoffEvent(paths, handoffId, "handoff_finished", options.status, payload);

	// Only the root handoff finishing means the run is over. Depth must be
	// part of the check, not parentage alone: a depth-0 role started without
	// a handoff of its own has no CODEFLOW_HANDOFF_ID to pass down, so its
	// delegations (always opened at depth 1 by extensions/codeflow-task) are
	// recorded parentless — parentage alone cannot tell "run root" from
	// "delegated by a handoff-less root". runnerExited below sets the
	// precedent for gating run-level events on depth 0.
	if ((state.depth ?? 0) === 0 && !state.lineage?.parent_handoff_id) {
			emitRunEvent(paths, "run_finished", options.status, {
				ref: `handoffs/${handoffId}/state.json`,
				handoff_id: handoffId,
				summary: options.summary,
			});
	}

	return {
		run_id: paths.runId,
		handoff_id: handoffId,
		status: options.status,
		state: paths.statePath(handoffId),
		receipt: receipt !== null ? paths.receiptPath(handoffId) : null,
		facts_recorded: recordedFacts.map((record) => record.id),
	};
}

function buildBudgetFailure(budget: NonNullable<FinishOptions["budget"]>): Record<string, unknown> {
	return {
		budget: {
			limit: budget.limit ?? null,
			used: budget.used ?? null,
			remaining: budget.remaining ?? null,
		},
		protected_component: budget.protectedComponent ?? null,
		required_action: budget.requiredAction ?? null,
		largest_sources: budget.largestSources ?? [],
		source_refs: budget.sourceRefs ?? [],
	};
}

export function handoffStatus(paths: RunPaths, handoffId?: string): HandoffState | HandoffState[] {
	if (handoffId) {
		return decorateAge(requireState(paths, handoffId));
	}
	return loadStates(paths, true).map(decorateAge);
}

/** Bounded state view for audit: every handoff, not only currently active ones. */
export function handoffHistory(paths: RunPaths): HandoffState[] {
	return loadStates(paths, false).map(decorateAge);
}

export function handoffList(paths: RunPaths, onlyActive = false): Record<string, unknown>[] {
	return loadStates(paths, onlyActive).map((state) => ({
		handoff_id: state.handoff_id,
		role: state.role,
		depth: state.depth,
		status: state.status,
		result: state.result ?? (state.blocked as { reason?: string } | undefined)?.reason ?? null,
		title: titleFor(paths, state),
		scope: state.scope ?? [],
	}));
}

export function runStart(
	paths: RunPaths,
	role: string,
	pid: number,
	requirement = "",
): { run_id: string; runner: string } {
	const runner: Record<string, unknown> = {
		schema_version: SCHEMA_VERSION,
		run_id: paths.runId,
		role,
		pid,
		started_at: nowIso(),
		// Stored so the outer ring can label a run without opening anything
		// that belongs to the execute loop.
		requirement,
	};
	const file = path.join(paths.runDir, "runner.json");
	writeJsonAtomic(file, runner);
	emitRunEvent(paths, "run_started", "STARTED", { ref: "runner.json", role });
	return { run_id: paths.runId, runner: file };
}

/** Start another depth-0 attempt inside an existing fully stopped run. */
export function runResume(
	paths: RunPaths,
	role: string,
	pid: number,
): { run_id: string; runner: string; resume_count: number } {
	const attempt = assertResumeStopped(paths);
	const file = path.join(paths.runDir, "runner.json");
	const previous = readJson<Record<string, unknown>>(file);
	const resumedAt = nowIso();
	const resumeCount =
		typeof previous.resume_count === "number" ? previous.resume_count + 1 : 1;
	const runner: Record<string, unknown> = {
		...previous,
		role,
		pid,
		started_at: resumedAt,
		resumed_at: resumedAt,
		resume_count: resumeCount,
	};
	delete runner.child_pid;
	delete runner.pgid;

	// The previous attempt's start sequence is immutable, so an exclusive file
	// is an atomic, permanent claim on exactly that attempt. A second process
	// cannot pass the lifecycle check and race this one into another root
	// planner; a later completed attempt has a different start sequence.
	const claims = path.join(paths.runDir, ".resume-claims");
	const claim = path.join(claims, String(attempt.startSeq));
	fs.mkdirSync(claims, { recursive: true });
	try {
		fs.writeFileSync(
			claim,
			JSON.stringify({
				schema_version: SCHEMA_VERSION,
				run_id: paths.runId,
				start_seq: attempt.startSeq,
				pid,
				claimed_at: nowIso(),
			}) + "\n",
			{ encoding: "utf-8", flag: "wx" },
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new ResumeError(`resume already claimed for the latest attempt: ${paths.runId}`);
		}
		throw error;
	}

	writeJsonAtomic(file, runner);
	emitRunEvent(paths, "run_resumed", "STARTED", {
		ref: "runner.json",
		role,
		summary: `run resumed (attempt ${resumeCount + 1})`,
	});
	return { run_id: paths.runId, runner: file, resume_count: resumeCount };
}

/**
 * Record the depth-0 agent process once it exists.
 *
 * `runner.pid` is the supervisor that must reap the agent; `child_pid` is the
 * agent whose process goal carries the agent's descendants. Keeping both lets
 * observation distinguish "supervisor is alive" from "the execute-loop tree can
 * still be signalled", and gives `stop` a target that does not depend on the
 * supervisor remaining alive to forward a signal.
 */
export function runnerChildStarted(
	paths: RunPaths,
	childPid: number,
	pgid: number = childPid,
): Record<string, unknown> {
	const file = path.join(paths.runDir, "runner.json");
	const runner = readJson<Record<string, unknown>>(file);
	runner.child_pid = childPid;
	runner.pgid = pgid;
	writeJsonAtomic(file, runner);
	return runner;
}

/**
 * A depth-0 exit is the last mechanical opportunity to close handoffs that
 * still claim to be active. This never invents success: an unfinished handoff
 * becomes BLOCKED with a missing artifact, after which the outer loop sees a
 * terminal business event before `runner_exited`.
 */
function closeAbandonedHandoffs(paths: RunPaths): void {
	if (!fs.existsSync(paths.active)) return;
	const active = fs
		.readdirSync(paths.active)
		.map((handoffId) => {
			try {
				const state = readJson<HandoffState>(paths.statePath(handoffId));
				return { handoffId, state };
			} catch {
				return null;
			}
		})
		.filter((entry): entry is { handoffId: string; state: HandoffState } => entry !== null)
		// Children close before the root so run_finished is the final business
		// terminal event rather than being followed by a stale child closure.
		.sort((left, right) => (right.state.depth ?? 0) - (left.state.depth ?? 0));

	for (const { handoffId, state } of active) {
		try {
			if (state.status !== "open" && state.status !== "running") continue;
			finishHandoff(paths, {
				handoffId,
				status: "BLOCKED",
				summary: "runner exited without finishing this handoff",
				blockedReasons: ["DELEGATION_ARTIFACT_MISSING"],
				detail: "The depth-0 runner exited while this handoff was still active.",
			});
		} catch {
			// Terminal or malformed state must not prevent the runner-exit event.
		}
	}
}

/**
 * Record a monitored process exit; only depth 0 reaches the event stream.
 *
 * A depth-1 child's exit is already observed by the parent delegation, so
 * publishing it would be noise the outer loop might mistake for a stop
 * signal. A depth-0 exit is different: nobody else is left to report that the
 * execute loop stopped.
 */
export function runnerExited(
	paths: RunPaths,
	pid: number,
	role: string,
	depth: number,
): { run_id: string; pid: number; depth: number; event: DeliveredEvent | null } {
	const livenessPath = path.join(paths.liveness, `${pid}--${slug(role)}--${depth}.json`);
	const eventMarker = path.join(paths.liveness, `${pid}--${slug(role)}--${depth}.runner-exited`);
	if (depth === 0 && fs.existsSync(eventMarker)) {
		return { run_id: paths.runId, pid, depth, event: null };
	}
	if (depth !== 0 && fs.existsSync(livenessPath)) {
		try {
			if (readJson<Record<string, unknown>>(livenessPath).status === "exited") {
				return { run_id: paths.runId, pid, depth, event: null };
			}
		} catch {
			// Replace malformed liveness with the terminal record below.
		}
	}
	const record = {
		schema_version: SCHEMA_VERSION,
		run_id: paths.runId,
		pid,
		role,
		depth,
		status: "exited",
		exited_at: nowIso(),
	};
	writeJsonAtomic(livenessPath, record);

	if (depth === 0) closeAbandonedHandoffs(paths);

	let event: DeliveredEvent | null = null;
	if (depth === 0) {
		fs.mkdirSync(paths.liveness, { recursive: true });
		let marker: number;
		try {
			marker = fs.openSync(eventMarker, "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				return { run_id: paths.runId, pid, depth, event: null };
			}
			throw error;
		}
		fs.closeSync(marker);
		try {
			event = emitRunEvent(paths, "runner_exited", "EXITED", {
				pid,
				role,
				ref: "runner.json",
			});
		} catch (error) {
			fs.rmSync(eventMarker, { force: true });
			throw error;
		}
	}
	return { run_id: paths.runId, pid, depth, event };
}

function heartbeatAge(record: Record<string, unknown>, now: number): number | null {
	const stamp = (record.heartbeat_at ?? record.started_at) as string | undefined;
	if (!stamp) return null;
	const parsed = Date.parse(stamp);
	if (Number.isNaN(parsed)) return null;
	return Math.max(0, Math.floor((now - parsed) / 1000));
}

/**
 * Derive the coordination board from three existing fact sources:
 * liveness/ (watchdog-maintained) x active/ (in-flight handoffs) x
 * handoffs/<id>/ (title and scope).
 *
 * Nothing has to remember to update a registry, so the view cannot fall out
 * of sync with reality. It is pull-only, never injected into a role's context
 * by the turn.
 */
export function agentsList(paths: RunPaths): Record<string, unknown>[] {
	const now = Date.now();
	const heartbeats = new Map<number, Record<string, unknown>>();
	if (fs.existsSync(paths.liveness)) {
		for (const name of fs.readdirSync(paths.liveness).sort()) {
			if (!name.endsWith(".json")) continue;
			try {
				const record = readJson<Record<string, unknown>>(path.join(paths.liveness, name));
				if (typeof record.pid === "number") heartbeats.set(record.pid, record);
			} catch {
				// Skip an unreadable heartbeat.
			}
		}
	}

	const rows: Record<string, unknown>[] = [];
	const claimed = new Set<number>();
	for (const state of loadStates(paths, true)) {
		const pid = state.pid;
		const record = pid !== undefined ? heartbeats.get(pid) : undefined;
		if (record && pid !== undefined) claimed.add(pid);
		rows.push({
			role: state.role,
			depth: state.depth,
			pid: state.pid ?? null,
			heartbeat_age_seconds: record ? heartbeatAge(record, now) : null,
			handoff_id: state.handoff_id,
			title: titleFor(paths, state),
			scope: state.scope ?? [],
			status: state.status,
		});
	}

	// A live process with no active handoff still belongs on the board: it is
	// exactly the case an outer loop needs to see.
	for (const [pid, record] of heartbeats) {
		if (claimed.has(pid) || record.status === "exited") continue;
		rows.push({
			role: record.role ?? null,
			depth: record.depth ?? null,
			pid,
			heartbeat_age_seconds: heartbeatAge(record, now),
			handoff_id: null,
			title: "",
			scope: [],
			status: record.status ?? "alive",
		});
	}

	rows.sort((left, right) => {
		const depth = ((left.depth as number) || 0) - ((right.depth as number) || 0);
		if (depth !== 0) return depth;
		const role = String(left.role ?? "").localeCompare(String(right.role ?? ""));
		if (role !== 0) return role;
		return String(left.handoff_id ?? "").localeCompare(String(right.handoff_id ?? ""));
	});
	return rows;
}
