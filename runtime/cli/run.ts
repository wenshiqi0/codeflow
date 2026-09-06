#!/usr/bin/env bun
/** Standalone single-executor baseline. Use codeteam for outer orchestration. */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { buildAgentArgv, ConfigError, resolveAgent, resolveOutputCompression } from "../lib/config";
import { AGENT_TOOL_ALLOWLIST, agentExtensions } from "../lib/agent-launch";
import {
	commitmentForExecution,
	loadTerminalReceipt,
	commitmentHistory,
	resumeCommitment,
	runResume,
	runStart,
	runnerChildStarted,
	runnerExited,
	reconcileDeadCommitments,
} from "../lib/commitment";
import { CONTEXT_BUDGET_ABORT_MARKER } from "../lib/runtime-signals";
import { loadWorkerReport } from "../lib/executions";
import { DEFAULT_RUNS_DIR, RunPaths } from "../lib/paths";
import { loadResumeSource, ResumeError, type ResumeSource } from "../lib/resume";
import { renderUsageSummary, writeUsageSummary } from "../lib/usage";

const RUNTIME_DIR = path.resolve(import.meta.dir, "..");
const CONFIG_FILE = path.join(RUNTIME_DIR, "config.json");
const VERSION = "0.2.0";
const ROOT_OUTPUT_DIAGNOSTIC_LIMIT = 8_000;

export function newRunId(now = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	return `task-${stamp}-${randomBytes(2).toString("hex")}`;
}

export function resolveRunsDir(configured: string | undefined, cwd: string = process.cwd()): string {
	return path.resolve(cwd, configured ?? DEFAULT_RUNS_DIR);
}

function fail(message: string, command = "exec"): number {
	console.error(`codeflow ${command}: error: ${message}`);
	return 1;
}

interface RootOutputObservation {
	stopReason?: string;
	errorMessage?: string;
	stdoutTail: string;
	stderrTail: string;
}

function interruptedReasons(
	code: number,
	observation: RootOutputObservation,
	aborted: boolean,
): import("../lib/commitment").RuntimeFailureReason[] {
	const reasons: import("../lib/commitment").RuntimeFailureReason[] = [];
	const diagnostics = `${observation.stderrTail}\n${observation.errorMessage ?? ""}`;
	if (diagnostics.includes(CONTEXT_BUDGET_ABORT_MARKER)) return ["CONTEXT_BUDGET_EXCEEDED"];
	if (aborted || observation.stopReason === "aborted") reasons.push("USER_CANCELLED");
	if (observation.stopReason === "length") reasons.push("OUTPUT_TRUNCATED");
	if (diagnostics.includes("CODEFLOW_EXECUTION_TIMEOUT")) reasons.push("EXECUTION_TIMEOUT");
	if (code !== 0 || observation.stopReason === "error") reasons.push("PROVIDER_FAILURE");
	return [...new Set(reasons)];
}

export function rootCommitmentForResume(paths: RunPaths) {
	return commitmentHistory(paths)
		.filter((view) => view.commitment.goal_id === paths.runId
			&& view.commitment.parent_commitment_id === null && view.folded.terminal === null)
		.sort((left, right) => right.commitment.seq - left.commitment.seq)[0]?.commitment ?? null;
}

function appendTail(current: string, chunk: string): string {
	const next = current + chunk;
	return next.length > ROOT_OUTPUT_DIAGNOSTIC_LIMIT ? next.slice(-ROOT_OUTPUT_DIAGNOSTIC_LIMIT) : next;
}

function observeLine(line: string, observation: RootOutputObservation): void {
	try {
		const event = JSON.parse(line);
		if (event.type !== "message_end" || event.message?.role !== "assistant") return;
		observation.stopReason = event.message.stopReason ?? observation.stopReason;
		observation.errorMessage = event.message.errorMessage ?? observation.errorMessage;
	} catch {
		// Ignore non-event stdout.
	}
}

async function drain(
	stream: unknown,
	onLine: (line: string) => void,
	onChunk: (chunk: string) => void,
): Promise<void> {
	if (!stream || typeof (stream as ReadableStream).getReader !== "function") return;
	const reader = (stream as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const text = decoder.decode(value, { stream: true });
		onChunk(text);
		buffer += text;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) onLine(line);
	}
	buffer += decoder.decode();
	if (buffer.trim()) onLine(buffer);
}

interface RunOptions { resume?: ResumeSource }

export interface ExecArguments {
	prompt: string;
	model?: string;
}

export function parseExecArguments(argv: string[]): ExecArguments {
	const objective: string[] = [];
	let model: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--model") {
			if (model !== undefined) {
				throw new ConfigError(`${value} may be specified only once`);
			}
			const next = argv[index + 1];
			if (!next || next.startsWith("--")) throw new ConfigError(`${value} requires '<provider>/<model>'`);
			model = next;
			index += 1;
			continue;
		}
		if (value.startsWith("--model=")) {
			const flag = "--model";
			if (model !== undefined) {
				throw new ConfigError(`${flag} may be specified only once`);
			}
			model = value.slice(`${flag}=`.length);
			if (!model) throw new ConfigError(`${flag} requires '<provider>/<model>'`);
			continue;
		}
		if (value.startsWith("--")) throw new ConfigError(`unknown exec option: ${value}`);
		objective.push(value);
	}
	const prompt = objective.join(" ").trim();
	if (!prompt) throw new ConfigError("exec requires a requirement");
	return { prompt, model };
}

export async function run(
	argv: string[],
	entry: "exec" | "resume" = "exec",
	options: RunOptions = {},
): Promise<number> {
	let prompt: string;
	let model: string | undefined;
	let resolved;
	try {
		if (entry === "exec") ({ prompt, model } = parseExecArguments(argv));
		else {
			if (argv.some((value) => value.startsWith("--"))) throw new ConfigError(`unknown ${entry} option`);
			prompt = argv.join(" ").trim();
			if (!prompt) throw new ConfigError(`${entry} requires a requirement`);
		}
		resolved = resolveAgent(CONFIG_FILE, model ?? process.env.CODEFLOW_AGENT_MODEL);
	} catch (error) {
		if (error instanceof ConfigError) return fail(error.message, entry);
		throw error;
	}

	const taskId = options.resume?.taskId ?? newRunId();
	const paths = new RunPaths(resolveRunsDir(process.env.CODEFLOW_RUNS_DIR), taskId);
	const objective = options.resume?.objective ?? prompt;
	if (options.resume) runResume(paths, process.pid);
	else runStart(paths, process.pid, objective);
	if (options.resume) reconcileDeadCommitments(paths, ["TERMINAL_RECEIPT_MISSING"]);
	const resumedCommitment = options.resume ? rootCommitmentForResume(paths) : null;
	const executionId = `exec_${randomBytes(12).toString("hex")}`;

	console.error(`codeflow task_id=${taskId} task_dir=${paths.runDir} execution_id=${executionId}${resumedCommitment ? ` commitment_id=${resumedCommitment.id}` : ""}${options.resume ? " resumed=true" : ""}`);
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		PATH: `${path.join(RUNTIME_DIR, "bin")}:${process.env.PATH ?? ""}`,
		PI_CODING_AGENT_DIR: RUNTIME_DIR,
		CODEFLOW_PROCESS_KIND: "root",
		CODEFLOW_RUN_ID: taskId,
		CODEFLOW_RUNS_DIR: paths.code,
		CODEFLOW_PROJECT_DIR: path.resolve(process.cwd()),
		CODEFLOW_EVIDENCE_DIR: paths.evidence,
		CODEFLOW_GOAL_ID: taskId,
		CODEFLOW_EXECUTION_ID: executionId,
		CODEFLOW_AGENT_MODEL: `${resolved.provider}/${resolved.model}`,
	};
	delete childEnv.CODEFLOW_PARENT_COMMITMENT_ID;
	delete childEnv.CODEFLOW_WORK_FOCUS;
	delete childEnv.CODEFLOW_TEAM_AGENT_ID;
	delete childEnv.CODEFLOW_TEAM_RUNNER_PID;
	delete childEnv.CODEFLOW_TEAM_SHELL_READY;
	if (resumedCommitment) childEnv.CODEFLOW_COMMITMENT_ID = resumedCommitment.id;
	else delete childEnv.CODEFLOW_COMMITMENT_ID;
	const child = Bun.spawn(
		buildAgentArgv(
			resolved,
			resumedCommitment
				? "Re-ground the Task from durable state and continue it to closure."
				: "Inspect the assigned Task, claim bounded work, implement and verify it, then report a Receipt.",
			agentExtensions(RUNTIME_DIR),
			AGENT_TOOL_ALLOWLIST,
		),
		{
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
			env: childEnv,
		},
	);
	if (child.pid !== undefined) runnerChildStarted(paths, child.pid);
	if (child.pid !== undefined && resumedCommitment) resumeCommitment(paths, resumedCommitment.id, executionId, child.pid);

	let escalation: ReturnType<typeof setTimeout> | undefined;
	let aborted = false;
	const terminate = () => {
		if (aborted) return;
		aborted = true;
		try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
		escalation = setTimeout(() => {
			try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
		}, 5_000);
	};
	process.on("SIGTERM", terminate);
	process.on("SIGINT", terminate);
	const observation: RootOutputObservation = { stdoutTail: "", stderrTail: "" };
	const drained = Promise.all([
		drain(child.stdout, (line) => observeLine(line, observation), (chunk) => { observation.stdoutTail = appendTail(observation.stdoutTail, chunk); }),
		drain(child.stderr, () => undefined, (chunk) => { observation.stderrTail = appendTail(observation.stderrTail, chunk); }),
	]);
	const code = await child.exited;
	// Root can crash before its extension runs shutdown. Its detached process
	// group is Task-owned, so reap orphaned descendants before draining pipes.
	try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already exited */ }
	await drained;
	// OS reaping can lag signal delivery. Wait only for this Task's recorded
	// PIDs, then reconcile confirmed-dead active markers for explicit recovery.
	const stoppedPids = commitmentHistory(paths).flatMap((view) => view.pid === null ? [] : [view.pid]);
	const cleanupDeadline = Date.now() + 2_000;
	while (Date.now() < cleanupDeadline && stoppedPids.some((pid) => {
		try { process.kill(pid, 0); return true; }
		catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
	})) await Bun.sleep(25);
	if (escalation) clearTimeout(escalation);
	process.off("SIGTERM", terminate);
	process.off("SIGINT", terminate);
	const rootCommitment = commitmentForExecution(paths, executionId) ?? resumedCommitment;
	const receipt = rootCommitment ? loadTerminalReceipt(paths, rootCommitment.id) : null;
	const report = loadWorkerReport(paths, executionId);
	const reasons = interruptedReasons(code, observation, aborted);
	if (!rootCommitment && !report && reasons.length === 0) reasons.push("COMMITMENT_CLAIM_MISSING");
	try {
		runnerExited(
			paths,
			child.pid,
			true,
			executionId,
			receipt ? undefined : {
				reasons,
				summary: report?.summary ?? (rootCommitment
					? "root Agent execution ended without a terminal Receipt"
					: "root Agent execution ended before claiming a Work Commitment"),
			},
		);
		reconcileDeadCommitments(paths, reasons.length > 0 ? reasons : ["TERMINAL_RECEIPT_MISSING"]);
	} catch { /* bookkeeping cannot mask execution */ }
	if (!receipt) {
		const tail = (observation.errorMessage ?? observation.stderrTail ?? observation.stdoutTail).trim().slice(-2_000);
		console.error(`codeflow ${entry}: root Agent exited without a terminal Receipt${report ? `; report=${JSON.stringify(report)}` : ""}${tail ? `; diagnostic tail:\n${tail}` : ""}`);
	}
	try {
		const summary = writeUsageSummary(paths);
		console.error(`codeflow usage_summary=${summary}`);
		console.error(renderUsageSummary(JSON.parse(fs.readFileSync(summary, "utf8"))));
	} catch {
		// Observability never changes the Task outcome.
	}
	return receipt ? code : 1;
}

async function resume(argv: string[]): Promise<number> {
	if (argv.length !== 1 || argv[0].startsWith("--")) return fail("resume requires exactly one task id", "resume");
	if (process.env.CODEFLOW_RUN_ID) return fail("resume cannot run inside a Codeflow task", "resume");
	try {
		const teamFile = path.join(resolveRunsDir(process.env.CODEFLOW_RUNS_DIR), argv[0], "team.json");
		if (fs.existsSync(teamFile)) return fail("outer-managed Tasks require codeteam resume <task> <agent> '<focus>'", "resume");
		const source = loadResumeSource(resolveRunsDir(process.env.CODEFLOW_RUNS_DIR), argv[0]);
		return await run(["Re-ground from durable Task, Goal, Commitment, Receipt, and current external state; then continue the Task."], "resume", { resume: source });
	} catch (error) {
		if (error instanceof ResumeError) return fail(error.message, "resume");
		throw error;
	}
}

function debug(argv: string[]): number {
	if (argv.length !== 1 || argv[0] !== "runtime") return fail("debug requires: runtime", "debug");
	const agent = resolveAgent(CONFIG_FILE, process.env.CODEFLOW_AGENT_MODEL);
	const compression = resolveOutputCompression(CONFIG_FILE);
	console.log(JSON.stringify({
		agent: {
			model: `${agent.provider}/${agent.model}`,
			thinking_level: agent.thinkingLevel ?? null,
			prompt: path.relative(path.dirname(RUNTIME_DIR), agent.promptPaths[0]),
		},
		services: {
			output_compression: {
				model: `${compression.provider}/${compression.model}`,
				prompt: path.relative(path.dirname(RUNTIME_DIR), compression.promptPaths[0]),
			},
		},
	}));
	return 0;
}

export async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (command === "exec") return await run(rest, "exec");
	if (command === "resume") return await resume(rest);
	if (command === "debug") return debug(rest);
	if (command === "--version") { console.log(VERSION); return 0; }
	return fail("usage: <exec|resume|debug> ...");
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
