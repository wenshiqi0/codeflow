import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	commitmentForExecution,
	commitmentView,
	loadCommitment,
	loadReceiptChain,
	loadTerminalReceipt,
	recordRuntimeFailure,
	resumeCommitment,
	type RuntimeFailureReason,
} from "../../lib/commitment";
import { buildWorkerArgv, resolveAgent, type ResolvedExecutor } from "../../lib/config";
import { loadWorkerReport, recordExecutionFailure, type WorkerReport } from "../../lib/executions";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";

const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG_FILE = path.join(RUNTIME_DIR, "config.json");
const CHILD_EXTENSIONS = [
	"provider-profiles",
	"codeflow-organization",
	"host-guard",
	"codeflow-context",
	"bash-compressor",
	"usage-ledger",
	"telemetry-ledger",
	"agent-watchdog",
].map((name) => path.join(RUNTIME_DIR, "extensions", name, "index.ts"));

export interface DelegateWorkerInput {
	goalId: string;
	focus: string;
	parentCommitmentId: string;
	resumeCommitmentId?: string;
}

export interface WorkerExecution {
	execution_id: string;
	goal_id: string;
	commitment_id: string | null;
	exit_code: number;
	stop_reason: string | null;
	receipt_id: string | null;
	status: string;
	report: WorkerReport | null;
	runtime_failure_reasons: RuntimeFailureReason[];
	retryable: boolean;
}

export interface WorkerLauncherDependencies {
	resolve?: () => ResolvedExecutor;
	spawnProcess?: typeof spawn;
	executionId?: string;
}

export function resolveLaunchWorker(modelOverride = process.env.CODEFLOW_WORKER_MODEL): ResolvedExecutor {
	return resolveAgent(CONFIG_FILE, "worker", modelOverride);
}

export function buildChildWorkerArgs(resolved: ResolvedExecutor, resuming = false): string[] {
	return buildWorkerArgv(
		resolved,
		resuming
			? "Re-ground the current Work Commitment from durable state, continue it, and close it with a terminal Receipt."
			: "Inspect the injected Goal and current state. Claim bounded work, then report progress, completion, or what blocks it.",
		CHILD_EXTENSIONS,
		null,
	).slice(1);
}

export function buildChildEnvironment(
	baseEnv: NodeJS.ProcessEnv,
	cwd: string,
	input: DelegateWorkerInput,
	executionId: string,
): Record<string, string | undefined> {
	const childEnv: Record<string, string | undefined> = {
		...baseEnv,
		PI_CODING_AGENT_DIR: RUNTIME_DIR,
		CODEFLOW_PROJECT_DIR: path.resolve(cwd),
		CODEFLOW_GOAL_ID: input.goalId,
		CODEFLOW_EXECUTION_ID: executionId,
		CODEFLOW_PARENT_COMMITMENT_ID: input.parentCommitmentId,
		CODEFLOW_WORK_FOCUS: input.focus,
		CODEFLOW_PROCESS_KIND: "worker",
	};
	if (input.resumeCommitmentId) childEnv.CODEFLOW_COMMITMENT_ID = input.resumeCommitmentId;
	else delete childEnv.CODEFLOW_COMMITMENT_ID;
	return childEnv;
}

function currentPaths(): RunPaths {
	const taskId = process.env.CODEFLOW_RUN_ID;
	if (!taskId) throw new Error("worker spawn requires a Codeflow Task");
	return new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, taskId);
}

function invocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const executable = path.basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(executable)
		? { command: "pi", args }
		: { command: process.execPath, args };
}

function reasonsFor(result: { exitCode: number; stopReason?: string; aborted: boolean; stderr: string }): RuntimeFailureReason[] {
	const reasons: RuntimeFailureReason[] = [];
	if (result.aborted || result.stopReason === "aborted") reasons.push("USER_CANCELLED");
	if (result.stopReason === "length") reasons.push("OUTPUT_TRUNCATED");
	if (result.stderr.includes("CODEFLOW_EXECUTION_TIMEOUT")) reasons.push("EXECUTION_TIMEOUT");
	if (result.exitCode !== 0 || result.stopReason === "error") reasons.push("PROVIDER_FAILURE");
	return [...new Set(reasons)];
}

function interrupted(
	executionId: string,
	goalId: string,
	reasons: RuntimeFailureReason[],
): WorkerExecution {
	return {
		execution_id: executionId,
		goal_id: goalId,
		commitment_id: null,
		exit_code: -1,
		stop_reason: null,
		receipt_id: null,
		status: "interrupted",
		report: null,
		runtime_failure_reasons: reasons,
		retryable: true,
	};
}

export async function spawnWorker(
	input: DelegateWorkerInput,
	signal: AbortSignal | undefined,
	cwd: string,
	dependencies: WorkerLauncherDependencies = {},
): Promise<WorkerExecution> {
	const paths = currentPaths();
	const executionId = dependencies.executionId ?? `exec_${randomBytes(12).toString("hex")}`;
	if (input.resumeCommitmentId) {
		const commitment = loadCommitment(paths, input.resumeCommitmentId);
		if (commitment.goal_id !== input.goalId) throw new Error("resumed Commitment does not belong to the requested Goal");
		const view = commitmentView(paths, commitment);
		if (view.folded.terminal) throw new Error(`commitment is already closed: ${commitment.id}`);
		if (view.pid !== null) throw new Error(`commitment is already running: ${commitment.id}`);
	}
	let args: string[];
	let command: { command: string; args: string[] };
	try {
		const resolved = (dependencies.resolve ?? resolveLaunchWorker)();
		args = buildChildWorkerArgs(resolved, input.resumeCommitmentId !== undefined);
		command = invocation(args);
	} catch {
		recordExecutionFailure(paths, executionId, input.goalId, ["WORKER_LAUNCH_FAILURE"], "Worker process could not be launched");
		return interrupted(executionId, input.goalId, ["WORKER_LAUNCH_FAILURE"]);
	}
	const childEnv = buildChildEnvironment(process.env, cwd, input, executionId);
	let buffer = "";
	let stopReason: string | undefined;
	let stderr = "";
	let aborted = false;
	let launched = false;
	let exitCode: number;
	try {
		exitCode = await new Promise<number>((resolve, reject) => {
			const child = (dependencies.spawnProcess ?? spawn)(command.command, command.args, {
				cwd,
				env: childEnv,
				stdio: ["ignore", "pipe", "pipe"],
			});
			if (child.pid !== undefined) {
				try {
					if (input.resumeCommitmentId) resumeCommitment(paths, input.resumeCommitmentId, executionId, child.pid);
				} catch (error) {
					child.kill("SIGTERM");
					reject(error);
					return;
				}
				launched = true;
			}
			let closed = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const stop = () => {
				aborted = true;
				child.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (!closed && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				}, 5_000);
			};
			const processLine = (line: string) => {
				try {
					const event = JSON.parse(line);
					if (event.type === "message_end" && event.message?.role === "assistant") {
						stopReason = event.message.stopReason ?? stopReason;
					}
				} catch {
					// Pi stdout is an event stream; a partial line is handled by the next chunk.
				}
			};
			child.stdout.on("data", (chunk) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) if (line.trim()) processLine(line);
			});
			child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
			child.on("error", (error) => { stderr += String(error); });
			child.on("close", (code) => {
				closed = true;
				if (killTimer) clearTimeout(killTimer);
				if (buffer.trim()) processLine(buffer);
				signal?.removeEventListener("abort", stop);
				resolve(code ?? 1);
			});
			if (signal?.aborted) stop();
			else signal?.addEventListener("abort", stop, { once: true });
		});
	} catch {
		recordExecutionFailure(paths, executionId, input.goalId, ["WORKER_LAUNCH_FAILURE"], "Worker launcher failed before execution");
		return interrupted(executionId, input.goalId, ["WORKER_LAUNCH_FAILURE"]);
	}
	if (!launched) {
		recordExecutionFailure(paths, executionId, input.goalId, ["WORKER_LAUNCH_FAILURE"], "Worker process could not be launched");
		return interrupted(executionId, input.goalId, ["WORKER_LAUNCH_FAILURE"]);
	}

	const report = loadWorkerReport(paths, executionId);
	const commitment = input.resumeCommitmentId
		? loadCommitment(paths, input.resumeCommitmentId)
		: commitmentForExecution(paths, executionId);
	if (!commitment) {
		if (report) {
			return {
				execution_id: executionId,
				goal_id: input.goalId,
				commitment_id: null,
				exit_code: exitCode,
				stop_reason: stopReason ?? null,
				receipt_id: null,
				status: "reported",
				report,
				runtime_failure_reasons: [],
				retryable: false,
			};
		}
		const reasons = reasonsFor({ exitCode, stopReason, aborted, stderr });
		if (reasons.length === 0) reasons.push("COMMITMENT_CLAIM_MISSING");
		recordExecutionFailure(paths, executionId, input.goalId, reasons, "Worker execution ended before claiming a Work Commitment");
		return { ...interrupted(executionId, input.goalId, reasons), exit_code: exitCode, stop_reason: stopReason ?? null };
	}

	const receipt = loadTerminalReceipt(paths, commitment.id);
	if (receipt) {
		return {
			execution_id: executionId,
			goal_id: input.goalId,
			commitment_id: commitment.id,
			exit_code: exitCode,
			stop_reason: stopReason ?? null,
			receipt_id: receipt.id,
			status: receipt.status,
			report: null,
			runtime_failure_reasons: [],
			retryable: false,
		};
	}
	const reasons = reasonsFor({ exitCode, stopReason, aborted, stderr });
	if (reasons.length === 0) reasons.push("TERMINAL_RECEIPT_MISSING");
	recordRuntimeFailure(paths, commitment.id, reasons, "Worker execution ended without a terminal Receipt");
	return {
		execution_id: executionId,
		goal_id: input.goalId,
		commitment_id: commitment.id,
		exit_code: exitCode,
		stop_reason: stopReason ?? null,
		receipt_id: null,
		status: "interrupted",
		report: null,
		runtime_failure_reasons: reasons,
		retryable: true,
	};
}

export interface WorkerLaunch {
	execution_id: string;
	goal_id: string;
	status: "running";
}

export interface WorkerReceiptUpdate {
	execution_id: string;
	goal_id: string;
	commitment_id: string;
	receipt_id: string;
	status: "progress";
}

export interface WorkerClaimUpdate {
	execution_id: string;
	goal_id: string;
	commitment_id: string;
	status: "running";
}

export type WorkerWaitResult =
	| WorkerExecution
	| WorkerClaimUpdate
	| WorkerReceiptUpdate
	| { status: "idle" };

const liveExecutions = new Map<string, Promise<WorkerExecution>>();
const settledExecutions = new Map<string, WorkerExecution>();
const observedClaims = new Set<string>();
const observedProgressSeq = new Map<string, number>();
const PROGRESS_POLL_MS = 250;

export function hasLiveWorkers(): boolean {
	return liveExecutions.size > 0;
}

/** Start a Worker without blocking the Root's collaboration loop. */
export function delegateWorker(
	input: DelegateWorkerInput,
	signal: AbortSignal | undefined,
	cwd: string,
	dependencies: WorkerLauncherDependencies = {},
): WorkerLaunch {
	const executionId = dependencies.executionId ?? `exec_${randomBytes(12).toString("hex")}`;
	const running = spawnWorker(input, signal, cwd, { ...dependencies, executionId }).catch(() => {
		const paths = currentPaths();
		recordExecutionFailure(paths, executionId, input.goalId, ["WORKER_LAUNCH_FAILURE"], "Worker launcher failed before execution");
		return interrupted(executionId, input.goalId, ["WORKER_LAUNCH_FAILURE"]);
	});
	liveExecutions.set(executionId, running);
	if (input.resumeCommitmentId) observedClaims.add(executionId);
	else observedClaims.delete(executionId);
	observedProgressSeq.set(executionId, 0);
	void running.then((execution) => {
		liveExecutions.delete(executionId);
		settledExecutions.set(executionId, execution);
	});
	return { execution_id: executionId, goal_id: input.goalId, status: "running" };
}

function nextWorkerUpdate(executionId: string): WorkerClaimUpdate | WorkerReceiptUpdate | null {
	const commitment = commitmentForExecution(currentPaths(), executionId);
	if (!commitment) return null;
	if (!observedClaims.has(executionId)) {
		observedClaims.add(executionId);
		return {
			execution_id: executionId,
			goal_id: commitment.goal_id,
			commitment_id: commitment.id,
			status: "running",
		};
	}
	const after = observedProgressSeq.get(executionId) ?? 0;
	const receipt = loadReceiptChain(currentPaths(), commitment.id).receipts.find(
		(candidate) => candidate.status === "progress" && candidate.seq > after,
	);
	if (!receipt) return null;
	observedProgressSeq.set(executionId, receipt.seq);
	return {
		execution_id: executionId,
		goal_id: commitment.goal_id,
		commitment_id: commitment.id,
		receipt_id: receipt.id,
		status: "progress",
	};
}

function consumeExecution(execution: WorkerExecution): WorkerExecution {
	settledExecutions.delete(execution.execution_id);
	observedClaims.delete(execution.execution_id);
	observedProgressSeq.delete(execution.execution_id);
	return execution;
}

function waitForNamedUpdate(
	executionId: string,
	running: Promise<WorkerExecution>,
): Promise<WorkerExecution | WorkerClaimUpdate | WorkerReceiptUpdate> {
	const current = nextWorkerUpdate(executionId);
	if (current) return Promise.resolve(current);
	return new Promise((resolve) => {
		let finished = false;
		const finish = (update: WorkerExecution | WorkerClaimUpdate | WorkerReceiptUpdate) => {
			if (finished) return;
			finished = true;
			clearInterval(poller);
			resolve(update);
		};
		const poller = setInterval(() => {
			const update = nextWorkerUpdate(executionId);
			if (update) finish(update);
		}, PROGRESS_POLL_MS);
		void running.then(finish);
	});
}

function waitForAnyUpdate(): Promise<WorkerExecution | WorkerClaimUpdate | WorkerReceiptUpdate> {
	for (const executionId of liveExecutions.keys()) {
		const current = nextWorkerUpdate(executionId);
		if (current) return Promise.resolve(current);
	}
	return new Promise((resolve) => {
		let finished = false;
		const finish = (update: WorkerExecution | WorkerClaimUpdate | WorkerReceiptUpdate) => {
			if (finished) return;
			finished = true;
			clearInterval(poller);
			resolve(update);
		};
		const poller = setInterval(() => {
			for (const executionId of liveExecutions.keys()) {
				const update = nextWorkerUpdate(executionId);
				if (update) {
					finish(update);
					return;
				}
			}
		}, PROGRESS_POLL_MS);
		for (const running of liveExecutions.values()) void running.then(finish);
	});
}

/** Yield until one named Worker, or any live Worker, claims, reports progress, or settles. */
export async function waitForWorker(executionId?: string): Promise<WorkerWaitResult> {
	if (executionId) {
		const settled = settledExecutions.get(executionId);
		if (settled) return consumeExecution(settled);
		const running = liveExecutions.get(executionId);
		if (!running) throw new Error(`unknown Worker execution: ${executionId}`);
		const update = await waitForNamedUpdate(executionId, running);
		return "exit_code" in update ? consumeExecution(update) : update;
	}
	const settled = settledExecutions.entries().next().value as [string, WorkerExecution] | undefined;
	if (settled) return consumeExecution(settled[1]);
	if (liveExecutions.size === 0) return { status: "idle" };
	const update = await waitForAnyUpdate();
	return "exit_code" in update ? consumeExecution(update) : update;
}
