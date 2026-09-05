/** Durable work protocol: immutable Commitment contracts with append-only Receipt chains. */

import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalJson, contentId } from "../canonical";
import { deliverEvent, eventSummary, type DeliveredEvent } from "../events";
import { assertGoalScope } from "../goals";
import { nowIso, readJson, RunPaths, writeJsonAtomic } from "../paths";
import { assertResumeStopped, ResumeError } from "../resume";
import { nextSeq } from "../seq";
import { createTask, loadTask } from "../tasks";

export const COMMITMENT_SCHEMA_VERSION = 1;
/** Chained Receipts: concise progress or one terminal outcome. */
export const RECEIPT_SCHEMA_VERSION = 1;

export const RECEIPT_STATUSES = [
	"completed",
	"blocked",
] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/** Non-terminal status: advances durable semantics without closing the Commitment. */
export const PROGRESS_STATUS = "progress" as const;
export type ProgressStatus = typeof PROGRESS_STATUS;
export type ReceiptChainStatus = ReceiptStatus | ProgressStatus;
export const RECEIPT_CHAIN_STATUSES = [...RECEIPT_STATUSES, PROGRESS_STATUS] as const;

/** Only a terminal status closes a Commitment. */
export function isTerminalStatus(status: string): status is ReceiptStatus {
	return (RECEIPT_STATUSES as readonly string[]).includes(status);
}

export type TerminalReceipt = ReceiptRecord & { status: ReceiptStatus };

/** Narrow one Receipt to its terminal form. */
export function isTerminalReceipt(receipt: ReceiptRecord): receipt is TerminalReceipt {
	return isTerminalStatus(receipt.status);
}

export const RUNTIME_FAILURE_REASONS = [
	"CONTEXT_BUDGET_EXCEEDED",
	"COMMITMENT_CLAIM_MISSING",
	"TERMINAL_RECEIPT_MISSING",
	"EXECUTION_TIMEOUT",
	"OUTPUT_TRUNCATED",
	"PROVIDER_FAILURE",
	"USER_CANCELLED",
	"WORKER_LAUNCH_FAILURE",
] as const;
export type RuntimeFailureReason = (typeof RUNTIME_FAILURE_REASONS)[number];

export class CliError extends Error {}

export type EffectReference =
	| { git: string }
	| { file: string }
	| { external: string }
	| { service: Record<string, unknown> };

export interface CommitmentRecord {
	schema_version: 1;
	id: string;
	seq: number;
	task_id: string;
	goal_id: string;
	worker_execution_id: string;
	claim_revision: number;
	work: string;
	done_when: string[];
	constraints: string[];
	parent_commitment_id: string | null;
}

export interface ReceiptRecord {
	schema_version: 1;
	id: string;
	seq: number;
	task_id: string;
	goal_id: string;
	commitment_id: string;
	/** `progress` is non-terminal; `completed` and `blocked` close the Commitment. */
	status: ReceiptChainStatus;
	summary: string;
	effects: EffectReference[];
	remaining: string[];
}

/** Folded semantics of one Commitment's Receipt chain plus its head metadata. */
export interface FoldedReceipts {
	/** Append-only chain in (seq, id) order; schema v2 for new writes. */
	receipts: ReceiptRecord[];
	/** The newest Receipt, progress or terminal. */
	head: ReceiptRecord | null;
	/** The Receipt that closed the Commitment, if any. */
	terminal: TerminalReceipt | null;
	/** Ordered report summaries and deduplicated observable effects. */
	summaries: string[];
	effects: EffectReference[];
	/** The latest Worker's statement of what remains. */
	remaining: string[];
}

export interface CommitmentView {
	commitment: CommitmentRecord;
	status: "open" | "running" | ReceiptStatus;
	pid: number | null;
	folded: FoldedReceipts;
}

export interface ClaimOptions {
	goalId: string;
	workerExecutionId: string;
	basedOnRevision: number;
	work: string;
	doneWhen?: string[];
	constraints?: string[];
	parentCommitmentId?: string | null;
	pid?: number;
}

export interface PreparedClaimOptions {
	goalId: string;
	workerExecutionId: string;
	basedOnRevision: number;
	work: string;
	doneWhen: string[];
	constraints: string[];
	parentCommitmentId: string | null;
	pid: number;
}

export interface SubmitReceiptOptions {
	commitmentId: string;
	/** A `progress` Receipt reports without closing the Commitment. */
	status: ReceiptChainStatus;
	summary: string;
	effects?: EffectReference[];
	remaining?: string[];
}

const CLAIM_LOCK_STALE_MS = 30_000;

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function claimLockIsActive(file: string): boolean {
	try {
		const stat = fs.statSync(file);
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
		if (typeof parsed.pid === "number") return processIsAlive(parsed.pid);
		return Date.now() - stat.mtimeMs < CLAIM_LOCK_STALE_MS;
	} catch {
		try { return Date.now() - fs.statSync(file).mtimeMs < CLAIM_LOCK_STALE_MS; }
		catch { return false; }
	}
}

function acquireClaimLock(file: string, goalId: string): number {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const descriptor = fs.openSync(file, "wx");
			try {
				fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, acquired_at: nowIso() }));
			} catch (error) {
				fs.closeSync(descriptor);
				fs.rmSync(file, { force: true });
				throw error;
			}
			return descriptor;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (claimLockIsActive(file)) {
				throw new CliError(`another Worker is claiming work in Goal ${goalId}; inspect the Goal and retry`);
			}
			fs.rmSync(file, { force: true });
		}
	}
	throw new CliError(`could not acquire the claim lock for Goal ${goalId}`);
}

function nonEmpty(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new CliError(`${field} must be a non-empty string`);
	}
	return value.trim();
}

function strings(values: unknown, field: string): string[] {
	if (!Array.isArray(values)) throw new CliError(`${field} must be an array`);
	return values.map((value, index) => nonEmpty(value, `${field}[${index}]`));
}

function effects(values: unknown): EffectReference[] {
	if (!Array.isArray(values)) throw new CliError("effects must be an array");
	const allowed = new Set(["git", "file", "external", "service"]);
	return values.map((value, index) => {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			throw new CliError(`effects[${index}] must be an object`);
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record);
		if (keys.length !== 1 || !allowed.has(keys[0])) {
			throw new CliError(
				`effects[${index}] must contain exactly one of git, file, external, service`,
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

function commitmentContent(record: Omit<CommitmentRecord, "id">): Omit<CommitmentRecord, "id"> {
	return record;
}

function receiptContent(record: Omit<ReceiptRecord, "id">): Omit<ReceiptRecord, "id"> {
	return record;
}

function verifyCommitment(record: CommitmentRecord, expectedTaskId: string): CommitmentRecord {
	if (record.schema_version !== COMMITMENT_SCHEMA_VERSION || record.task_id !== expectedTaskId) {
		throw new CliError(`malformed commitment: ${record.id ?? "unknown"}`);
	}
	const { id, ...content } = record;
	if (contentId("c", commitmentContent(content)) !== id) {
		throw new CliError(`commitment content hash mismatch: ${id}`);
	}
	return record;
}

function verifyReceipt(record: ReceiptRecord, commitment: CommitmentRecord): ReceiptRecord {
	if (
		record.schema_version !== RECEIPT_SCHEMA_VERSION ||
		record.task_id !== commitment.task_id ||
		record.goal_id !== commitment.goal_id ||
		record.commitment_id !== commitment.id ||
		!(RECEIPT_CHAIN_STATUSES as readonly string[]).includes(record.status)
	) {
		throw new CliError(`malformed receipt for commitment: ${commitment.id}`);
	}
	const { id, ...content } = record;
	if (contentId("r", receiptContent(content)) !== id) {
		throw new CliError(`receipt content hash mismatch: ${id}`);
	}
	return record;
}

export interface FoldedReports {
	summaries: string[];
	effects: EffectReference[];
	remaining: string[];
}

/** Fold concise reports in deterministic order without inventing fact taxonomies. */
export function foldReceipts(receipts: readonly ReceiptRecord[]): FoldedReports {
	const seenEffects = new Set<string>();
	const folded: FoldedReports = { summaries: [], effects: [], remaining: [] };
	for (const receipt of receipts) {
		folded.summaries.push(receipt.summary);
		for (const effect of receipt.effects) {
			const key = canonicalJson(effect);
			if (!seenEffects.has(key)) {
				seenEffects.add(key);
				folded.effects.push(effect);
			}
		}
		folded.remaining = [...receipt.remaining];
	}
	return folded;
}

const CHAIN_FILE = /^(\d{5})--(r_[0-9a-f]{64})\.json$/;

function readChain(paths: RunPaths, commitment: CommitmentRecord): ReceiptRecord[] {
	const directory = paths.receiptDir(commitment.id);
	if (!fs.existsSync(directory)) return [];
	const entries = fs
		.readdirSync(directory)
		.map((name) => {
			const match = CHAIN_FILE.exec(name);
			return match ? { seq: Number.parseInt(match[1], 10), id: match[2] } : null;
		})
		.filter((entry): entry is { seq: number; id: string } => entry !== null)
		.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
	return entries.map((entry) =>
		verifyReceipt(readJson<ReceiptRecord>(paths.receiptChainPath(commitment.id, entry.seq, entry.id)), commitment),
	);
}

/** Read and fold the whole Receipt chain of one Commitment. */
export function loadReceiptChain(paths: RunPaths, commitmentId: string): FoldedReceipts {
	const commitment = loadCommitment(paths, commitmentId);
	const receipts = readChain(paths, commitment);
	return {
		receipts,
		head: receipts.at(-1) ?? null,
		terminal: receipts.findLast(isTerminalReceipt) ?? null,
		...foldReceipts(receipts),
	};
}

/** True when the Commitment recorded at least one Receipt but no terminal one. */
export function hasDurableProgress(folded: FoldedReceipts): boolean {
	return folded.receipts.length > 0 && folded.terminal === null;
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

function emitCommitmentEvent(
	paths: RunPaths,
	commitmentId: string,
	kind: string,
	status: string,
	payload: Record<string, unknown>,
): DeliveredEvent {
	return deliverEvent({
		stagingDir: paths.tmp,
		targetDir: paths.events,
		counterPath: paths.eventSeq,
		subject: commitmentId,
		kind,
		status,
		payload: { ...payload, task_id: paths.runId, commitment_id: commitmentId },
	});
}

function activePath(paths: RunPaths, commitmentId: string): string {
	return path.join(paths.active, `${commitmentId}.json`);
}

function readActive(paths: RunPaths, commitmentId: string): { pid: number; execution_id: string } | null {
	try {
		return readJson(activePath(paths, commitmentId));
	} catch {
		return null;
	}
}

/** Current Goal-local collaboration revision. Only a new Commitment advances it. */
export function goalClaimRevision(paths: RunPaths, goalId: string): number {
	assertGoalScope(paths, goalId);
	return commitmentHistory(paths)
		.filter((view) => view.commitment.goal_id === goalId)
		.reduce((revision, view) => Math.max(revision, view.commitment.claim_revision), 0);
}

/** Validate and normalize a self-authored Commitment claim without writing state. */
export function prepareClaim(
	paths: RunPaths,
	options: ClaimOptions,
): PreparedClaimOptions {
	loadTask(paths);
	assertGoalScope(paths, options.goalId);
	if (options.parentCommitmentId) loadCommitment(paths, options.parentCommitmentId);
	if (!Number.isSafeInteger(options.basedOnRevision) || options.basedOnRevision < 0) {
		throw new CliError("based_on_revision must be a non-negative integer");
	}
	return {
		goalId: nonEmpty(options.goalId, "goal_id"),
		workerExecutionId: nonEmpty(options.workerExecutionId, "worker_execution_id"),
		basedOnRevision: options.basedOnRevision,
		work: nonEmpty(options.work, "work"),
		doneWhen: strings(options.doneWhen ?? [], "done_when"),
		constraints: strings(options.constraints ?? [], "constraints"),
		parentCommitmentId: options.parentCommitmentId ?? null,
		pid: options.pid ?? process.pid,
	};
}

export function claimCommitment(paths: RunPaths, options: ClaimOptions): CommitmentRecord {
	const prepared = prepareClaim(paths, options);
	fs.mkdirSync(paths.claimLocks, { recursive: true });
	const lock = paths.claimLockPath(prepared.goalId);
	const descriptor = acquireClaimLock(lock, prepared.goalId);
	try {
		const currentRevision = goalClaimRevision(paths, prepared.goalId);
		if (prepared.basedOnRevision !== currentRevision) {
			throw new CliError(
				`stale Goal claim revision: expected ${currentRevision}, received ${prepared.basedOnRevision}; inspect the Goal and reconsider the work`,
			);
		}
		const content: Omit<CommitmentRecord, "id"> = {
			schema_version: COMMITMENT_SCHEMA_VERSION,
			seq: nextSeq(paths.semanticSeq),
			task_id: paths.runId,
				goal_id: prepared.goalId,
				worker_execution_id: prepared.workerExecutionId,
				claim_revision: currentRevision + 1,
				work: prepared.work,
				done_when: prepared.doneWhen,
				constraints: prepared.constraints,
				parent_commitment_id: prepared.parentCommitmentId,
		};
		const record: CommitmentRecord = { id: contentId("c", commitmentContent(content)), ...content };
		if (fs.existsSync(paths.commitmentDir(record.id))) throw new CliError(`commitment already exists: ${record.id}`);
		writeJsonAtomic(paths.commitmentPath(record.id), record);
		writeJsonAtomic(activePath(paths, record.id), {
			pid: prepared.pid,
			execution_id: prepared.workerExecutionId,
		});
		emitCommitmentEvent(paths, record.id, "commitment_claimed", "RUNNING", {
			goal_id: record.goal_id,
			execution_id: record.worker_execution_id,
			ref: path.relative(paths.runDir, paths.commitmentPath(record.id)),
				summary: record.work,
		});
		return record;
	} finally {
		fs.closeSync(descriptor);
		fs.rmSync(lock, { force: true });
	}
}

export function loadCommitment(paths: RunPaths, commitmentId: string): CommitmentRecord {
	const file = paths.commitmentPath(commitmentId);
	if (!fs.existsSync(file)) throw new CliError(`unknown commitment: ${commitmentId}`);
	return verifyCommitment(readJson<CommitmentRecord>(file), paths.runId);
}

/** The Receipt that closed the Commitment, if any. */
export function loadTerminalReceipt(paths: RunPaths, commitmentId: string): TerminalReceipt | null {
	return loadReceiptChain(paths, commitmentId).terminal;
}

/** Resume a previously self-authored, interrupted Commitment. */
export function resumeCommitment(paths: RunPaths, commitmentId: string, executionId: string, pid: number): CommitmentView {
	const commitment = loadCommitment(paths, commitmentId);
	if (loadReceiptChain(paths, commitmentId).terminal) throw new CliError(`commitment is already closed: ${commitmentId}`);
	const active = readActive(paths, commitmentId);
	if (active) throw new CliError(`commitment is already running: ${commitmentId}`);
	writeJsonAtomic(activePath(paths, commitmentId), { pid, execution_id: executionId });
	emitCommitmentEvent(paths, commitmentId, "commitment_resumed", "RUNNING", {
		goal_id: commitment.goal_id,
		execution_id: executionId,
		ref: path.relative(paths.runDir, paths.commitmentPath(commitmentId)),
	});
	return commitmentView(paths, commitment);
}

/** Reconcile only Task-owned executions whose recorded PID is confirmed gone. */
export function reconcileDeadCommitments(paths: RunPaths, reasons: RuntimeFailureReason[], commitmentIds?: readonly string[]): number {
	let cleared = 0;
	for (const view of commitmentHistory(paths)) {
		if (commitmentIds && !commitmentIds.includes(view.commitment.id)) continue;
		if (view.folded.terminal || view.pid === null || !Number.isSafeInteger(view.pid) || view.pid <= 0) continue;
		try { process.kill(view.pid, 0); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
			recordRuntimeFailure(paths, view.commitment.id, reasons, "Agent process is confirmed stopped; preserve its Commitment for explicit resume");
			cleared++;
		}
	}
	return cleared;
}

export function submitReceipt(paths: RunPaths, options: SubmitReceiptOptions): ReceiptRecord {
	const commitment = loadCommitment(paths, options.commitmentId);
	const prior = loadReceiptChain(paths, commitment.id);
	if (prior.terminal) throw new CliError(`commitment is already closed: ${commitment.id}`);
	if (!(RECEIPT_CHAIN_STATUSES as readonly string[]).includes(options.status)) {
		throw new CliError(`status must be one of ${RECEIPT_CHAIN_STATUSES.join(", ")}`);
	}
	const remaining = strings(options.remaining ?? [], "remaining");
	if (options.status === "blocked" && remaining.length === 0) {
		throw new CliError("a blocked Receipt must explain what remains");
	}
	if (options.status === "completed" && remaining.length > 0) {
		throw new CliError("a completed Receipt cannot contain remaining work");
	}
	const content: Omit<ReceiptRecord, "id"> = {
		schema_version: RECEIPT_SCHEMA_VERSION,
		seq: nextSeq(paths.semanticSeq),
		task_id: commitment.task_id,
		goal_id: commitment.goal_id,
		commitment_id: commitment.id,
		status: options.status,
		summary: nonEmpty(options.summary, "summary"),
		effects: effects(options.effects ?? []),
		remaining,
	};
	const receipt: ReceiptRecord = { id: contentId("r", receiptContent(content)), ...content };
	const receiptFile = paths.receiptChainPath(commitment.id, receipt.seq, receipt.id);
	if (fs.existsSync(receiptFile)) throw new CliError(`receipt already exists: ${receipt.id}`);
	writeJsonAtomic(receiptFile, receipt);
	const isTerminal = isTerminalStatus(receipt.status);
	if (isTerminal) fs.rmSync(activePath(paths, commitment.id), { force: true });
	const status = receipt.status.toUpperCase();
	const summary = receipt.summary;
	emitCommitmentEvent(paths, commitment.id, "receipt_submitted", isTerminal ? status : "PROGRESS", {
		goal_id: commitment.goal_id,
		receipt_id: receipt.id,
		receipt_ref: path.relative(paths.runDir, receiptFile),
		summary: eventSummary(summary),
	});
	if (isTerminal && commitment.goal_id === paths.runId && commitment.parent_commitment_id === null) {
		emitRunEvent(paths, "run_finished", status, {
			commitment_id: commitment.id,
			receipt_id: receipt.id,
			receipt_ref: path.relative(paths.runDir, receiptFile),
			summary: eventSummary(summary),
		});
	}
	return receipt;
}

export function commitmentView(paths: RunPaths, commitment: CommitmentRecord): CommitmentView {
	const folded = loadReceiptChain(paths, commitment.id);
	const active = folded.terminal ? null : readActive(paths, commitment.id);
	return {
		commitment,
		status: folded.terminal?.status ?? (active ? "running" : "open"),
		pid: typeof active?.pid === "number" ? active.pid : null,
		folded,
	};
}

export function commitmentHistory(paths: RunPaths): CommitmentView[] {
	if (!fs.existsSync(paths.commitments)) return [];
	return fs
		.readdirSync(paths.commitments, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.filter((entry) => {
			// Atomic publication creates the directory before commitment.json is
			// renamed into place. Unpublished directories are not Commitments yet.
			try { fs.statSync(paths.commitmentPath(entry.name)); return true; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
				throw error;
			}
		})
		.map((entry) => commitmentView(paths, loadCommitment(paths, entry.name)))
		.sort((left, right) => left.commitment.seq - right.commitment.seq || left.commitment.id.localeCompare(right.commitment.id));
}

export function commitmentStatus(paths: RunPaths, commitmentId?: string): CommitmentView | CommitmentView[] {
	if (commitmentId) return commitmentView(paths, loadCommitment(paths, commitmentId));
	return commitmentHistory(paths).filter((view) => view.folded.terminal === null);
}

export function commitmentForExecution(paths: RunPaths, executionId: string): CommitmentRecord | null {
	return commitmentHistory(paths)
		.filter((view) => view.commitment.worker_execution_id === executionId)
		.sort((left, right) => right.commitment.seq - left.commitment.seq)[0]?.commitment ?? null;
}

export function commitmentList(paths: RunPaths, onlyActive = false): Record<string, unknown>[] {
	return commitmentHistory(paths)
		.filter((view) => !onlyActive || view.folded.terminal === null)
		.map((view) => ({
			commitment_id: view.commitment.id,
			seq: view.commitment.seq,
			goal_id: view.commitment.goal_id,
			status: view.status,
				work: view.commitment.work,
			receipt_id: view.folded.terminal?.id ?? null,
		}));
}

export function recordRuntimeFailure(
	paths: RunPaths,
	commitmentId: string,
	reasons: RuntimeFailureReason[],
	summary: string,
): void {
	const commitment = loadCommitment(paths, commitmentId);
	if (loadReceiptChain(paths, commitmentId).terminal) return;
	for (const reason of reasons) {
		if (!(RUNTIME_FAILURE_REASONS as readonly string[]).includes(reason)) {
			throw new CliError(`unknown runtime failure reason: ${reason}`);
		}
	}
	fs.rmSync(activePath(paths, commitmentId), { force: true });
	emitCommitmentEvent(paths, commitmentId, "execution_interrupted", "INTERRUPTED", {
		goal_id: commitment.goal_id,
		reasons,
		ref: path.relative(paths.runDir, paths.commitmentPath(commitmentId)),
		summary: eventSummary(summary),
	});
}

function runningCommitmentForProcess(paths: RunPaths, pid: number, root: boolean): CommitmentRecord | null {
	const candidates = commitmentHistory(paths)
		.filter((view) => {
			if (view.folded.terminal !== null || view.pid !== pid || view.status !== "running") return false;
			return root ? view.commitment.goal_id === paths.runId : true;
		})
		.sort((left, right) => right.commitment.seq - left.commitment.seq);
	return candidates[0]?.commitment ?? null;
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
	executionId: string,
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

	const interrupted = runningCommitmentForProcess(paths, pid, true);
	if (interrupted) {
		const folded = loadReceiptChain(paths, interrupted.id);
		const reasons: RuntimeFailureReason[] = interruption?.reasons.length
			? interruption.reasons
			: ["TERMINAL_RECEIPT_MISSING"];
		const summary = interruption?.summary
			?? (folded.receipts.length > 0
				? "root Worker ended after durable progress without a terminal Receipt"
				: "root Worker exited without a Receipt");
		recordRuntimeFailure(paths, interrupted.id, reasons, summary);
		emitRunEvent(paths, "run_interrupted", "INTERRUPTED", {
			commitment_id: interrupted.id,
			reasons,
			summary: eventSummary(summary),
		});
	} else if (interruption) {
		const reasons = interruption.reasons;
		const summary = interruption?.summary ?? "root Worker exited before claiming a Work Commitment";
		emitRunEvent(paths, "run_interrupted", "INTERRUPTED", {
			execution_id: executionId,
			reasons,
			summary: eventSummary(summary),
		});
	}
	fs.mkdirSync(paths.liveness, { recursive: true });
	fs.writeFileSync(marker, "", { flag: "wx" });
	const event = emitRunEvent(paths, "runner_exited", "EXITED", { pid, ref: "runner.json" });
	return { task_id: paths.runId, pid, event };
}
