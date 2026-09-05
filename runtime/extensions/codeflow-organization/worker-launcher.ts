import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	commitmentForExecution,
	commitmentHistory,
	commitmentView,
	loadCommitment,
	loadReceiptChain,
	loadTerminalReceipt,
	recordRuntimeFailure,
	reconcileDeadCommitments,
	resumeCommitment,
	type RuntimeFailureReason,
} from "../../lib/commitment";
import { buildAgentArgv, resolveAgent, type ResolvedExecutor } from "../../lib/config";
import { AGENT_TOOL_ALLOWLIST, agentExtensions } from "../../lib/agent-launch";
import { reserveAgentSlot, descendantAgentPids, closeAgentSubtree, type AgentLease } from "../../lib/agent-capacity";
import { loadWorkerReport, recordExecutionFailure, type WorkerReport } from "../../lib/executions";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";
import { CONTEXT_BUDGET_ABORT_MARKER } from "../../lib/runtime-signals";

const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG_FILE = path.join(RUNTIME_DIR, "config.json");

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
	lease?: AgentLease;
}

export function resolveLaunchWorker(modelOverride = process.env.CODEFLOW_AGENT_MODEL): ResolvedExecutor {
	return resolveAgent(CONFIG_FILE, modelOverride);
}

export function buildChildWorkerArgs(resolved: ResolvedExecutor, resuming = false): string[] {
	return buildAgentArgv(
		resolved,
		resuming
			? "Re-ground the current Work Commitment from durable state and continue it. Implement, verify, and organize; delegate bounded independent work when it can improve speed or quality. Reconcile delegated work before closing with a terminal Receipt."
			: "Inspect enough of the injected Goal and current state to claim bounded work. Implement, verify, and organize; delegate bounded independent work when it can improve speed or quality. Report progress, completion, or what blocks it.",
		agentExtensions(RUNTIME_DIR),
		AGENT_TOOL_ALLOWLIST,
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
	if (result.stderr.includes(CONTEXT_BUDGET_ABORT_MARKER)) return ["CONTEXT_BUDGET_EXCEEDED"];
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
	const lease = dependencies.lease ?? reserveAgentSlot(paths, executionId, process.env.CODEFLOW_EXECUTION_ID ?? loadCommitment(paths, input.parentCommitmentId).worker_execution_id);
	try {
		return await spawnLeasedAgent(input, signal, cwd, { ...dependencies, executionId, lease });
	} finally {
		lease.release();
	}
}

async function spawnLeasedAgent(
	input: DelegateWorkerInput,
	signal: AbortSignal | undefined,
	cwd: string,
	dependencies: WorkerLauncherDependencies & { executionId: string; lease: AgentLease },
): Promise<WorkerExecution> {
	const paths = currentPaths();
	const executionId = dependencies.executionId;
	if (input.resumeCommitmentId) {
		reconcileDeadCommitments(paths, ["TERMINAL_RECEIPT_MISSING"], [input.resumeCommitmentId]);
		const commitment = loadCommitment(paths, input.resumeCommitmentId);
		if (commitment.goal_id !== input.goalId) throw new Error("resumed Commitment does not belong to the requested Goal");
		if (commitment.parent_commitment_id !== input.parentCommitmentId) throw new Error("resumed Commitment does not belong to the current parent");
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
			let closed = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const killDescendants = (kind: NodeJS.Signals) => {
				try {
					closeAgentSubtree(paths, executionId);
					for (const pid of descendantAgentPids(paths, executionId)) {
						try { process.kill(pid, kind); } catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ESRCH") stderr += String(error);
						}
					}
				} catch (error) { stderr += `Agent descendant cleanup failed: ${String(error)}`; }
			};
			const stop = () => {
				if (aborted || closed) return;
				aborted = true;
				killDescendants("SIGTERM");
				child.kill("SIGTERM");
				killTimer = setTimeout(() => {
					killDescendants("SIGKILL");
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
			child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-64_000); });
			child.on("error", (error) => { stderr += String(error); });
			child.on("close", (code) => {
				closed = true;
				// A crashed parent must not leave nested Agents running outside its lifetime.
				killDescendants("SIGKILL");
				if (killTimer) clearTimeout(killTimer);
				if (buffer.trim()) processLine(buffer);
				signal?.removeEventListener("abort", stop);
				resolve(code ?? 1);
			});
			// Install all listeners and escalation before publishing the PID. A
			// setup error must retain capacity until the real child has exited.
			if (child.pid !== undefined) {
				try {
					dependencies.lease.attach(child.pid);
					if (input.resumeCommitmentId) resumeCommitment(paths, input.resumeCommitmentId, executionId, child.pid);
					launched = true;
				} catch (error) {
					stderr += String(error);
					stop();
				}
			}
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
	status: "progress" | "completed" | "blocked";
}

export interface WorkerClaimUpdate {
	execution_id: string;
	goal_id: string;
	commitment_id: string;
	status: "running";
}

export type WorkerFeedback =
	| WorkerExecution
	| WorkerClaimUpdate
	| WorkerReceiptUpdate;

interface TrackedExecution {
	paths: RunPaths;
	resumeCommitmentId?: string;
	observedRecords: Set<string>;
	abortController: AbortController;
	removeAbortListener: () => void;
	result?: WorkerExecution;
}

const trackedExecutions = new Map<string, TrackedExecution>();

export function hasLiveWorkers(): boolean {
	return [...trackedExecutions.values()].some((execution) => execution.result === undefined);
}

/** Cancel all live children and descendants, including launches from earlier turns. */
export function cancelWorkers(): void {
	for (const execution of trackedExecutions.values()) {
		if (execution.result !== undefined) continue;
		execution.removeAbortListener();
		execution.abortController.abort();
	}
}

/** Start a child Agent without blocking the parent's collaboration loop. */
export function delegateWorker(
	input: DelegateWorkerInput,
	signal: AbortSignal | undefined,
	cwd: string,
	dependencies: WorkerLauncherDependencies = {},
): WorkerLaunch {
	const executionId = dependencies.executionId ?? `exec_${randomBytes(12).toString("hex")}`;
	if (trackedExecutions.has(executionId)) throw new Error(`Worker execution is already tracked: ${executionId}`);
	const paths = currentPaths();
	const abortController = new AbortController();
	const abort = () => abortController.abort();
	const tracked: TrackedExecution = {
		paths,
		resumeCommitmentId: input.resumeCommitmentId,
		observedRecords: new Set(),
		abortController,
		removeAbortListener: () => signal?.removeEventListener("abort", abort),
	};
	// A resumed execution receives its existing history in the startup context.
	// Only records appended during this execution are new feedback.
	if (input.resumeCommitmentId) {
		tracked.observedRecords.add(input.resumeCommitmentId);
		for (const receipt of loadReceiptChain(paths, input.resumeCommitmentId).receipts) {
			tracked.observedRecords.add(receipt.id);
		}
	}
	// Reserve synchronously so saturation returns an actionable tool error, not a phantom launch.
	const lease = reserveAgentSlot(paths, executionId, process.env.CODEFLOW_EXECUTION_ID ?? loadCommitment(paths, input.parentCommitmentId).worker_execution_id);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const running = spawnWorker(input, abortController.signal, cwd, { ...dependencies, executionId, lease }).catch(() => {
		recordExecutionFailure(paths, executionId, input.goalId, ["WORKER_LAUNCH_FAILURE"], "Worker launcher failed before execution");
		return interrupted(executionId, input.goalId, ["WORKER_LAUNCH_FAILURE"]);
	});
	trackedExecutions.set(executionId, tracked);
	void running.then((execution) => {
		tracked.removeAbortListener();
		tracked.result = execution;
	});
	return { execution_id: executionId, goal_id: input.goalId, status: "running" };
}

/** Take every new durable record and execution result without waiting for a Worker. */
export function takeWorkerUpdates(): WorkerFeedback[] {
	const records: { seq: number; id: string; owner: TrackedExecution; update: WorkerFeedback }[] = [];
	const endings: [string, WorkerExecution][] = [];
	const histories = new Map<string, ReturnType<typeof commitmentHistory>>();
	for (const [executionId, tracked] of trackedExecutions) {
		let history = histories.get(tracked.paths.runDir);
		if (!history) {
			history = commitmentHistory(tracked.paths);
			histories.set(tracked.paths.runDir, history);
		}
		for (const { commitment, folded } of history) {
			if (commitment.worker_execution_id !== executionId && commitment.id !== tracked.resumeCommitmentId) continue;
			if (!tracked.observedRecords.has(commitment.id)) {
				records.push({
					seq: commitment.seq,
					id: commitment.id,
					owner: tracked,
					update: {
						execution_id: executionId,
						goal_id: commitment.goal_id,
						commitment_id: commitment.id,
						status: "running",
					},
				});
			}
			for (const receipt of folded.receipts) {
				if (tracked.observedRecords.has(receipt.id)) continue;
				records.push({
					seq: receipt.seq,
					id: receipt.id,
					owner: tracked,
					update: {
						execution_id: executionId,
						goal_id: receipt.goal_id,
						commitment_id: commitment.id,
						receipt_id: receipt.id,
						status: receipt.status,
					},
				});
			}
		}
		if (tracked.result) endings.push([executionId, tracked.result]);
	}
	// Read the complete batch before advancing any cursors. A transient read error
	// cannot consume part of a batch that the caller never received.
	records.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
	for (const record of records) record.owner.observedRecords.add(record.id);
	// A fast Worker may settle between polls. Flush all of its Claims and Receipts
	// before its exit result, and retire its tracking only after collecting both.
	for (const [executionId] of endings) trackedExecutions.delete(executionId);
	return [...records.map((record) => record.update), ...endings.map(([, execution]) => execution)];
}
