#!/usr/bin/env bun
/** Start or resume the root Worker for one Task. */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { buildWorkerArgv, ConfigError, resolveOutputCompression, resolveWorker } from "../lib/config";
import {
	loadReceipt,
	handoffHistory,
	attachHandoffProcess,
	openHandoff,
	startHandoff,
	runResume,
	runStart,
	runnerChildStarted,
	runnerExited,
} from "../lib/handoff";
import { DEFAULT_RUNS_DIR, RunPaths } from "../lib/paths";
import { loadResumeSource, ResumeError, type ResumeSource } from "../lib/resume";
import { renderUsageSummary, writeUsageSummary } from "../lib/usage";

const RUNTIME_DIR = path.resolve(import.meta.dir, "..");
const CONFIG_FILE = path.join(RUNTIME_DIR, "config.json");
const VERSION = "0.2.0";
const ROOT_OUTPUT_DIAGNOSTIC_LIMIT = 8_000;
const ROOT_EXTENSIONS = [
	"provider-profiles",
	"codeflow-organization",
	"codeflow-protocol",
	"host-guard",
	"codeflow-context",
	"bash-compressor",
	"usage-ledger",
	"telemetry-ledger",
	"agent-watchdog",
].map((name) => path.join(RUNTIME_DIR, "extensions", name, "index.ts"));

export function newRunId(now = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	return `task-${stamp}-${randomBytes(2).toString("hex")}`;
}

export function resolveRunsDir(configured: string | undefined, cwd: string = process.cwd()): string {
	return path.resolve(cwd, configured ?? DEFAULT_RUNS_DIR);
}

export function openRootHandoffForRun(paths: RunPaths, objective: string) {
	const digest = objective.replace(/\s+/g, " ").trim().slice(0, 240);
	return openHandoff(paths, {
		goalId: paths.runId,
		digest,
		intent: objective,
		expectedOutcome: ["The Task objective is fulfilled and remaining uncertainty is explicit"],
		evidenceRequirement: ["Provide executable or directly observable evidence where applicable"],
	});
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
): import("../lib/handoff").RuntimeFailureReason[] {
	const reasons: import("../lib/handoff").RuntimeFailureReason[] = [];
	if (aborted || observation.stopReason === "aborted") reasons.push("USER_CANCELLED");
	if (observation.stopReason === "length") reasons.push("OUTPUT_TRUNCATED");
	const diagnostics = `${observation.stderrTail}\n${observation.errorMessage ?? ""}`;
	if (diagnostics.includes("CODEFLOW_EXECUTION_TIMEOUT")) reasons.push("EXECUTION_TIMEOUT");
	if (code !== 0 || observation.stopReason === "error") reasons.push("PROVIDER_FAILURE");
	if (reasons.length === 0) reasons.push("DELEGATION_ARTIFACT_MISSING");
	return [...new Set(reasons)];
}

function rootHandoffForAttempt(paths: RunPaths, prompt: string, resumed: boolean) {
	if (resumed) {
		const interrupted = handoffHistory(paths)
			.filter((view) => view.handoff.goal_id === paths.runId && view.receipt === null)
			.sort((left, right) => right.handoff.seq - left.handoff.seq)[0];
		if (interrupted) return interrupted.handoff;
	}
	return openRootHandoffForRun(paths, prompt);
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

export async function run(
	argv: string[],
	entry: "exec" | "resume" = "exec",
	options: RunOptions = {},
): Promise<number> {
	if (process.env.CODEFLOW_RUN_ID) return fail(`${entry} cannot start inside a Codeflow Task`, entry);
	if (argv.some((value) => value.startsWith("--"))) return fail(`unknown ${entry} option`, entry);
	const prompt = argv.join(" ").trim();
	if (!prompt) return fail(`${entry} requires a requirement`, entry);
	let resolved;
	try {
		resolved = resolveWorker(CONFIG_FILE);
	} catch (error) {
		if (error instanceof ConfigError) return fail(error.message, entry);
		throw error;
	}

	const taskId = options.resume?.taskId ?? newRunId();
	const paths = new RunPaths(resolveRunsDir(process.env.CODEFLOW_RUNS_DIR), taskId);
	const objective = options.resume?.objective ?? prompt;
	if (options.resume) runResume(paths, process.pid);
	else runStart(paths, process.pid, objective);
	const root = rootHandoffForAttempt(paths, prompt, options.resume !== undefined);
	startHandoff(paths, root.id);

	console.error(`codeflow task_id=${taskId} task_dir=${paths.runDir} handoff_id=${root.id}${options.resume ? " resumed=true" : ""}`);
	const child = Bun.spawn(
		buildWorkerArgv(resolved, "Execute the current root Handoff from the injected Codeflow context and submit one Receipt.", ROOT_EXTENSIONS),
		{
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
			env: {
				...process.env,
				PATH: `${path.join(RUNTIME_DIR, "bin")}:${process.env.PATH ?? ""}`,
				PI_CODING_AGENT_DIR: RUNTIME_DIR,
				CODEFLOW_PROCESS_KIND: "root",
				CODEFLOW_RUN_ID: taskId,
				CODEFLOW_RUNS_DIR: paths.code,
				CODEFLOW_PROJECT_DIR: path.resolve(process.cwd()),
				CODEFLOW_EVIDENCE_DIR: paths.evidence,
				CODEFLOW_HANDOFF_ID: root.id,
				CODEFLOW_GOAL_ID: taskId,
			},
		},
	);
	if (child.pid !== undefined) runnerChildStarted(paths, child.pid);
	if (child.pid !== undefined) attachHandoffProcess(paths, root.id, child.pid);

	let escalation: ReturnType<typeof setTimeout> | undefined;
	let aborted = false;
	const terminate = () => {
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
	await drained;
	if (escalation) clearTimeout(escalation);
	process.off("SIGTERM", terminate);
	process.off("SIGINT", terminate);
	const receipt = loadReceipt(paths, root.id);
	try {
		runnerExited(
			paths,
			child.pid,
			true,
			receipt ? undefined : {
				reasons: interruptedReasons(code, observation, aborted),
				summary: "root Worker execution ended without a Receipt",
			},
		);
	} catch { /* bookkeeping cannot mask execution */ }
	if (!receipt) {
		const tail = (observation.errorMessage ?? observation.stderrTail ?? observation.stdoutTail).trim().slice(-2_000);
		console.error(`codeflow ${entry}: root Worker exited without a Receipt${tail ? `; diagnostic tail:\n${tail}` : ""}`);
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
		const source = loadResumeSource(resolveRunsDir(process.env.CODEFLOW_RUNS_DIR), argv[0]);
		return await run(["Re-ground from durable Task, Goal, Handoff, Receipt, and current external state; then continue the Task."], "resume", { resume: source });
	} catch (error) {
		if (error instanceof ResumeError) return fail(error.message, "resume");
		throw error;
	}
}

function debug(argv: string[]): number {
	if (argv.length !== 1 || argv[0] !== "runtime") return fail("debug requires: runtime", "debug");
	const worker = resolveWorker(CONFIG_FILE);
	const compression = resolveOutputCompression(CONFIG_FILE);
	console.log(JSON.stringify({
		worker: { model: `${worker.provider}/${worker.model}`, prompt: path.relative(path.dirname(RUNTIME_DIR), worker.promptPath) },
		services: {
			output_compression: {
				model: `${compression.provider}/${compression.model}`,
				prompt: path.relative(path.dirname(RUNTIME_DIR), compression.promptPath),
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
