/** Durable work protocol: immutable Handoff contracts closed by immutable Receipts. */

import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalJson, contentId } from "../canonical";
import { deliverEvent, eventSummary, type DeliveredEvent } from "../events";
import { assertGoalScope } from "../goals";
import { nowIso, readJson, RunPaths, writeJsonAtomic } from "../paths";
import { assertResumeStopped, ResumeError } from "../resume";
import { nextSeq } from "../seq";
import { createTask, loadTask } from "../tasks";

export const HANDOFF_SCHEMA_VERSION = 1;
export const RECEIPT_SCHEMA_VERSION = 1;

export const RECEIPT_STATUSES = [
	"completed",
	"partial",
	"blocked",
	"failed",
	"superseded",
] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export const RUNTIME_FAILURE_REASONS = [
	"CONTEXT_BUDGET_EXCEEDED",
	"DELEGATION_ARTIFACT_MISSING",
	"EXECUTION_TIMEOUT",
	"OUTPUT_TRUNCATED",
	"PROVIDER_FAILURE",
	"USER_CANCELLED",
	"WORKER_LAUNCH_FAILURE",
] as const;
export type RuntimeFailureReason = (typeof RUNTIME_FAILURE_REASONS)[number];

export class CliError extends Error {}

export interface ExternalReference {
	kind: string;
	ref: string;
}

export type EffectReference =
	| { git: string }
	| { file: string }
	| { external: string }
	| { semantic: string }
	| { service: Record<string, unknown> };

export interface HandoffRecord {
	schema_version: 1;
	id: string;
	seq: number;
	task_id: string;
	goal_id: string;
	digest: string;
	intent: string;
	known: string[];
	references: ExternalReference[];
	constraints: string[];
	expected_outcome: string[];
	evidence_requirement: string[];
	parent_handoff_id: string | null;
}

export interface ReceiptRecord {
	schema_version: 1;
	id: string;
	seq: number;
	task_id: string;
	goal_id: string;
	handoff_id: string;
	status: ReceiptStatus;
	effects: EffectReference[];
	established: string[];
	decisions: string[];
	discovered: string[];
	unresolved: string[];
	blockers: string[];
}

export interface HandoffView {
	handoff: HandoffRecord;
	receipt: ReceiptRecord | null;
	status: "open" | "running" | ReceiptStatus;
	pid: number | null;
}

export interface OpenOptions {
	goalId: string;
	digest: string;
	intent: string;
	known?: string[];
	references?: ExternalReference[];
	constraints?: string[];
	expectedOutcome: string[];
	evidenceRequirement?: string[];
	parentHandoffId?: string | null;
}

export interface PreparedOpenOptions {
	goalId: string;
	digest: string;
	intent: string;
	known: string[];
	references: ExternalReference[];
	constraints: string[];
	expectedOutcome: string[];
	evidenceRequirement: string[];
	parentHandoffId: string | null;
}

export interface SubmitReceiptOptions {
	handoffId: string;
	status: ReceiptStatus;
	effects?: EffectReference[];
	established?: string[];
	decisions?: string[];
	discovered?: string[];
	unresolved?: string[];
	blockers?: string[];
}

function nonEmpty(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new CliError(`${field} must be a non-empty string`);
	}
	return value.trim();
}

function strings(values: unknown, field: string, required = false): string[] {
	if (!Array.isArray(values)) throw new CliError(`${field} must be an array`);
	const normalized = values.map((value, index) => nonEmpty(value, `${field}[${index}]`));
	if (required && normalized.length === 0) throw new CliError(`${field} must not be empty`);
	return normalized;
}

function references(values: unknown): ExternalReference[] {
	if (!Array.isArray(values)) throw new CliError("references must be an array");
	return values.map((value, index) => {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			throw new CliError(`references[${index}] must be an object`);
		}
		const record = value as Record<string, unknown>;
		return {
			kind: nonEmpty(record.kind, `references[${index}].kind`),
			ref: nonEmpty(record.ref, `references[${index}].ref`),
		};
	});
}

function effects(values: unknown): EffectReference[] {
	if (!Array.isArray(values)) throw new CliError("effects must be an array");
	const allowed = new Set(["git", "file", "external", "semantic", "service"]);
	return values.map((value, index) => {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			throw new CliError(`effects[${index}] must be an object`);
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record);
		if (keys.length !== 1 || !allowed.has(keys[0])) {
			throw new CliError(
				`effects[${index}] must contain exactly one of git, file, external, semantic, service`,
			);
		}
		if (keys[0] === "service") {
			if (record.service === null || typeof record.service !== "object" || Array.isArray(record.service)) {
				throw new CliError(`effects[${index}].service must be an object`);
			}
		} else {
			nonEmpty(record[keys[0]], `effects[${index}].${keys[0]}`);
		}
		return record as EffectReference;
	});
}

function handoffContent(record: Omit<HandoffRecord, "id">): Omit<HandoffRecord, "id"> {
	return record;
}

function receiptContent(record: Omit<ReceiptRecord, "id">): Omit<ReceiptRecord, "id"> {
	return record;
}

function verifyHandoff(record: HandoffRecord, expectedTaskId: string): HandoffRecord {
	if (record.schema_version !== HANDOFF_SCHEMA_VERSION || record.task_id !== expectedTaskId) {
		throw new CliError(`malformed handoff: ${record.id ?? "unknown"}`);
	}
	const { id, ...content } = record;
	if (contentId("h", handoffContent(content)) !== id) {
		throw new CliError(`handoff content hash mismatch: ${id}`);
	}
	return record;
}

function verifyReceipt(record: ReceiptRecord, handoff: HandoffRecord): ReceiptRecord {
	if (
		record.schema_version !== RECEIPT_SCHEMA_VERSION ||
		record.task_id !== handoff.task_id ||
		record.goal_id !== handoff.goal_id ||
		record.handoff_id !== handoff.id ||
		!(RECEIPT_STATUSES as readonly string[]).includes(record.status)
	) {
		throw new CliError(`malformed receipt for handoff: ${handoff.id}`);
	}
	const { id, ...content } = record;
	if (contentId("r", receiptContent(content)) !== id) {
		throw new CliError(`receipt content hash mismatch: ${id}`);
	}
	return record;
}

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
		payload: { ...payload, task_id: paths.runId },
	});
	return deliverEvent({
		stagingDir: path.join(paths.spool, "tmp"),
		targetDir: paths.spool,
		counterPath: path.join(paths.spool, ".events.seq"),
		subject: paths.runId,
		kind,
		status,
		payload: { ...payload, task_id: paths.runId },
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
		payload: { ...payload, task_id: paths.runId, handoff_id: handoffId },
	});
}

function activePath(paths: RunPaths, handoffId: string): string {
	return path.join(paths.active, `${handoffId}.json`);
}

function readActive(paths: RunPaths, handoffId: string): { pid?: number; started?: boolean } | null {
	try {
		return readJson(activePath(paths, handoffId));
	} catch {
		return null;
	}
}

/** Validate and normalize a Handoff without allocating a sequence or writing state. */
export function prepareHandoff(
	paths: RunPaths,
	options: OpenOptions,
	additionalGoalIds: readonly string[] = [],
): PreparedOpenOptions {
	loadTask(paths);
	if (!additionalGoalIds.includes(options.goalId)) assertGoalScope(paths, options.goalId);
	if (options.parentHandoffId) loadHandoff(paths, options.parentHandoffId);
	return {
		goalId: nonEmpty(options.goalId, "goal_id"),
		digest: nonEmpty(options.digest, "digest"),
		intent: nonEmpty(options.intent, "intent"),
		known: strings(options.known ?? [], "known"),
		references: references(options.references ?? []),
		constraints: strings(options.constraints ?? [], "constraints"),
		expectedOutcome: strings(options.expectedOutcome, "expected_outcome", true),
		evidenceRequirement: strings(options.evidenceRequirement ?? [], "evidence_requirement"),
		parentHandoffId: options.parentHandoffId ?? null,
	};
}

export function openHandoff(paths: RunPaths, options: OpenOptions): HandoffRecord {
	const prepared = prepareHandoff(paths, options);
	const content: Omit<HandoffRecord, "id"> = {
		schema_version: HANDOFF_SCHEMA_VERSION,
		seq: nextSeq(paths.semanticSeq),
		task_id: paths.runId,
		goal_id: prepared.goalId,
		digest: prepared.digest,
		intent: prepared.intent,
		known: prepared.known,
		references: prepared.references,
		constraints: prepared.constraints,
		expected_outcome: prepared.expectedOutcome,
		evidence_requirement: prepared.evidenceRequirement,
		parent_handoff_id: prepared.parentHandoffId,
	};
	const record: HandoffRecord = { id: contentId("h", handoffContent(content)), ...content };
	const directory = paths.handoffDir(record.id);
	if (fs.existsSync(directory)) throw new CliError(`handoff already exists: ${record.id}`);
	writeJsonAtomic(paths.handoffPath(record.id), record);
	writeJsonAtomic(activePath(paths, record.id), { started: false });
	emitHandoffEvent(paths, record.id, "handoff_opened", "OPEN", {
		goal_id: record.goal_id,
		ref: path.relative(paths.runDir, paths.handoffPath(record.id)),
		summary: record.digest,
	});
	return record;
}

export function loadHandoff(paths: RunPaths, handoffId: string): HandoffRecord {
	const file = paths.handoffPath(handoffId);
	if (!fs.existsSync(file)) throw new CliError(`unknown handoff: ${handoffId}`);
	return verifyHandoff(readJson<HandoffRecord>(file), paths.runId);
}

export function loadReceipt(paths: RunPaths, handoffId: string): ReceiptRecord | null {
	const handoff = loadHandoff(paths, handoffId);
	const file = paths.receiptPath(handoffId);
	if (!fs.existsSync(file)) return null;
	return verifyReceipt(readJson<ReceiptRecord>(file), handoff);
}

export function startHandoff(paths: RunPaths, handoffId: string, pid?: number): HandoffView {
	const handoff = loadHandoff(paths, handoffId);
	if (loadReceipt(paths, handoffId)) throw new CliError(`handoff is already closed: ${handoffId}`);
	const active = readActive(paths, handoffId);
	if (active?.started) throw new CliError(`handoff is already running: ${handoffId}`);
	writeJsonAtomic(activePath(paths, handoffId), { started: true, ...(pid === undefined ? {} : { pid }) });
	emitHandoffEvent(paths, handoffId, "handoff_started", "RUNNING", {
		goal_id: handoff.goal_id,
		ref: path.relative(paths.runDir, paths.handoffPath(handoffId)),
	});
	return handoffView(paths, handoff);
}

export function attachHandoffProcess(paths: RunPaths, handoffId: string, pid: number): void {
	const handoff = loadHandoff(paths, handoffId);
	if (loadReceipt(paths, handoff.id)) return;
	const active = readActive(paths, handoff.id);
	if (!active?.started) throw new CliError(`handoff is not running: ${handoff.id}`);
	writeJsonAtomic(activePath(paths, handoff.id), { started: true, pid });
}

export function submitReceipt(paths: RunPaths, options: SubmitReceiptOptions): ReceiptRecord {
	const handoff = loadHandoff(paths, options.handoffId);
	if (loadReceipt(paths, handoff.id)) throw new CliError(`handoff already has a receipt: ${handoff.id}`);
	if (!(RECEIPT_STATUSES as readonly string[]).includes(options.status)) {
		throw new CliError(`status must be one of ${RECEIPT_STATUSES.join(", ")}`);
	}
	const blockers = strings(options.blockers ?? [], "blockers");
	if (options.status === "blocked" && blockers.length === 0) {
		throw new CliError("a blocked receipt requires at least one blocker");
	}
	const content: Omit<ReceiptRecord, "id"> = {
		schema_version: RECEIPT_SCHEMA_VERSION,
		seq: nextSeq(paths.semanticSeq),
		task_id: handoff.task_id,
		goal_id: handoff.goal_id,
		handoff_id: handoff.id,
		status: options.status,
		effects: effects(options.effects ?? []),
		established: strings(options.established ?? [], "established"),
		decisions: strings(options.decisions ?? [], "decisions"),
		discovered: strings(options.discovered ?? [], "discovered"),
		unresolved: strings(options.unresolved ?? [], "unresolved"),
		blockers,
	};
	const receipt: ReceiptRecord = { id: contentId("r", receiptContent(content)), ...content };
	writeJsonAtomic(paths.receiptPath(handoff.id), receipt);
	fs.rmSync(activePath(paths, handoff.id), { force: true });
	const status = receipt.status.toUpperCase();
	const summary = receipt.established[0] ?? receipt.unresolved[0] ?? receipt.blockers[0] ?? receipt.status;
	emitHandoffEvent(paths, handoff.id, "receipt_submitted", status, {
		goal_id: handoff.goal_id,
		receipt_id: receipt.id,
		receipt_ref: path.relative(paths.runDir, paths.receiptPath(handoff.id)),
		summary: eventSummary(summary),
	});
	if (handoff.goal_id === paths.runId && handoff.parent_handoff_id === null) {
		emitRunEvent(paths, "run_finished", status, {
			handoff_id: handoff.id,
			receipt_id: receipt.id,
			receipt_ref: path.relative(paths.runDir, paths.receiptPath(handoff.id)),
			summary: eventSummary(summary),
		});
	}
	return receipt;
}

export function handoffView(paths: RunPaths, handoff: HandoffRecord): HandoffView {
	const receipt = loadReceipt(paths, handoff.id);
	const active = receipt ? null : readActive(paths, handoff.id);
	return {
		handoff,
		receipt,
		status: receipt?.status ?? (active?.started ? "running" : "open"),
		pid: typeof active?.pid === "number" ? active.pid : null,
	};
}

export function handoffHistory(paths: RunPaths): HandoffView[] {
	if (!fs.existsSync(paths.handoffs)) return [];
	return fs
		.readdirSync(paths.handoffs, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => handoffView(paths, loadHandoff(paths, entry.name)))
		.sort((left, right) => left.handoff.seq - right.handoff.seq || left.handoff.id.localeCompare(right.handoff.id));
}

export function handoffStatus(paths: RunPaths, handoffId?: string): HandoffView | HandoffView[] {
	if (handoffId) return handoffView(paths, loadHandoff(paths, handoffId));
	return handoffHistory(paths).filter((view) => view.receipt === null);
}

export function handoffList(paths: RunPaths, onlyActive = false): Record<string, unknown>[] {
	return handoffHistory(paths)
		.filter((view) => !onlyActive || view.receipt === null)
		.map((view) => ({
			handoff_id: view.handoff.id,
			seq: view.handoff.seq,
			goal_id: view.handoff.goal_id,
			status: view.status,
			digest: view.handoff.digest,
			receipt_id: view.receipt?.id ?? null,
		}));
}

export function recordRuntimeFailure(
	paths: RunPaths,
	handoffId: string,
	reasons: RuntimeFailureReason[],
	summary: string,
): void {
	const handoff = loadHandoff(paths, handoffId);
	if (loadReceipt(paths, handoffId)) return;
	for (const reason of reasons) {
		if (!(RUNTIME_FAILURE_REASONS as readonly string[]).includes(reason)) {
			throw new CliError(`unknown runtime failure reason: ${reason}`);
		}
	}
	fs.rmSync(activePath(paths, handoffId), { force: true });
	emitHandoffEvent(paths, handoffId, "execution_interrupted", "INTERRUPTED", {
		goal_id: handoff.goal_id,
		reasons,
		ref: path.relative(paths.runDir, paths.handoffPath(handoffId)),
		summary: eventSummary(summary),
	});
}

function runningHandoffForProcess(paths: RunPaths, pid: number, root: boolean): HandoffRecord | null {
	const candidates = handoffHistory(paths)
		.filter((view) => {
			if (view.receipt !== null || view.pid !== pid || view.status !== "running") return false;
			return root ? view.handoff.goal_id === paths.runId : true;
		})
		.sort((left, right) => right.handoff.seq - left.handoff.seq);
	return candidates[0]?.handoff ?? null;
}

export function runStart(
	paths: RunPaths,
	pid: number,
	objective: string,
): { task_id: string; runner: string } {
	createTask(paths, objective);
	const runner: Record<string, unknown> = {
		schema_version: 1,
		task_id: paths.runId,
		pid,
		started_at: nowIso(),
		objective,
	};
	const file = path.join(paths.runDir, "runner.json");
	writeJsonAtomic(file, runner);
	emitRunEvent(paths, "run_started", "STARTED", { ref: "runner.json", summary: objective });
	return { task_id: paths.runId, runner: file };
}

export function runResume(
	paths: RunPaths,
	pid: number,
): { task_id: string; runner: string; resume_count: number } {
	const attempt = assertResumeStopped(paths);
	loadTask(paths);
	const file = path.join(paths.runDir, "runner.json");
	const previous = readJson<Record<string, unknown>>(file);
	const resumeCount = typeof previous.resume_count === "number" ? previous.resume_count + 1 : 1;
	const claims = path.join(paths.runDir, ".resume-claims");
	const claim = path.join(claims, String(attempt.startSeq));
	fs.mkdirSync(claims, { recursive: true });
	try {
		fs.writeFileSync(claim, canonicalJson({ task_id: paths.runId, start_seq: attempt.startSeq, pid }), {
			encoding: "utf8",
			flag: "wx",
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new ResumeError(`resume already claimed for the latest attempt: ${paths.runId}`);
		}
		throw error;
	}
	const runner: Record<string, unknown> = {
		...previous,
		pid,
		started_at: nowIso(),
		resumed_at: nowIso(),
		resume_count: resumeCount,
	};
	delete runner.child_pid;
	delete runner.pgid;
	writeJsonAtomic(file, runner);
	emitRunEvent(paths, "run_resumed", "STARTED", { ref: "runner.json", summary: `task resumed ${resumeCount}` });
	return { task_id: paths.runId, runner: file, resume_count: resumeCount };
}

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

export function runnerExited(
	paths: RunPaths,
	pid: number,
	isRoot: boolean,
	interruption?: { reasons: RuntimeFailureReason[]; summary: string },
): { task_id: string; pid: number; event: DeliveredEvent | null } {
	const suffix = isRoot ? "root" : "worker";
	const livenessPath = path.join(paths.liveness, `${pid}--${suffix}.json`);
	const marker = path.join(paths.liveness, `${pid}--${suffix}.runner-exited`);
	if (fs.existsSync(marker)) return { task_id: paths.runId, pid, event: null };
	writeJsonAtomic(livenessPath, {
		schema_version: 1,
		task_id: paths.runId,
		pid,
		process: suffix,
		status: "exited",
		exited_at: nowIso(),
	});
	if (!isRoot) return { task_id: paths.runId, pid, event: null };

	const interrupted = runningHandoffForProcess(paths, pid, true);
	if (interrupted) {
		const reasons: RuntimeFailureReason[] = interruption?.reasons.length
			? interruption.reasons
			: ["DELEGATION_ARTIFACT_MISSING"];
		const summary = interruption?.summary ?? "root Worker exited without a Receipt";
		recordRuntimeFailure(paths, interrupted.id, reasons, summary);
		emitRunEvent(paths, "run_interrupted", "INTERRUPTED", {
			handoff_id: interrupted.id,
			reasons,
			summary: eventSummary(summary),
		});
	}
	fs.mkdirSync(paths.liveness, { recursive: true });
	fs.writeFileSync(marker, "", { flag: "wx" });
	const event = emitRunEvent(paths, "runner_exited", "EXITED", { pid, ref: "runner.json" });
	return { task_id: paths.runId, pid, event };
}
