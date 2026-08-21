#!/usr/bin/env bun
/**
 * `codeflow exec` and `code-agent delegate` — resolve a role and supervise its
 * pi process.
 *
 * One implementation, two entry points, because the two rings mean different
 * things by it. `exec` starts a run from a requirement: it allocates the run id
 * and announces it. `delegate` runs a role inside a run that already exists and
 * inherits that id from the environment. Splitting the spelling keeps "run" out
 * of a role's vocabulary entirely, so no role can mistake delegating a unit of
 * work for starting a whole run.
 *
 * pi is spawned and waited on rather than exec'd. Replacing this process would
 * leave nobody to reap pi or anything it detaches, which produces zombies
 * under a non-init PID 1 — the normal case in a container.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import {
	finishHandoff,
	openHandoff,
	runResume,
	runStart,
	runnerChildStarted,
	runnerExited,
} from "../lib/handoff";
import { DEFAULT_RUNS_DIR, RunPaths } from "../lib/paths";
import { loadResumeSource, ResumeError, type ResumeSource } from "../lib/resume";
import { buildArgv, listRoles, readRoleDefinition, resolveRole, RoleError } from "../lib/roles";
import { renderUsageSummary, writeUsageSummary } from "../lib/usage";

const RUNTIME_DIR = path.resolve(import.meta.dir, "..");
const ROLES_FILE = path.join(RUNTIME_DIR, "roles.json");
const VERSION = "0.1.0";
const ROOT_OUTPUT_DIAGNOSTIC_LIMIT = 8_000;
const EXTENSIONS = [
	path.join(RUNTIME_DIR, "extensions", "provider-profiles", "index.ts"),
	path.join(RUNTIME_DIR, "extensions", "codeflow-task", "index.ts"),
	path.join(RUNTIME_DIR, "extensions", "host-guard", "index.ts"),
	path.join(RUNTIME_DIR, "extensions", "codeflow-context", "index.ts"),
	path.join(RUNTIME_DIR, "extensions", "bash-compressor", "index.ts"),
	path.join(RUNTIME_DIR, "extensions", "usage-ledger", "index.ts"),
	path.join(RUNTIME_DIR, "extensions", "telemetry-ledger", "index.ts"),
	path.join(RUNTIME_DIR, "extensions", "agent-watchdog", "index.ts"),
];

/**
 * Sortable, lowercase, filesystem- and event-filename-safe.
 *
 * Sortable matters: run directories listed alphabetically come out in
 * chronological order, so finding the latest run needs no metadata.
 */
export function newRunId(now = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	return `run-${stamp}-${randomBytes(2).toString("hex")}`;
}

/**
 * Anchor run state before any child moves to a sibling worktree.
 *
 * `code-agent` deliberately changes to the worktree it is operating on. A
 * relative run root inherited by that child would therefore name a different
 * directory, while an absolute root keeps coordination state attached to the
 * checkout that launched the run.
 */
export function resolveRunsDir(
	configured: string | undefined,
	cwd: string = process.cwd(),
): string {
	return path.resolve(cwd, configured ?? DEFAULT_RUNS_DIR);
}

/**
 * `exec` must give its depth-0 planner the same terminal contract as every
 * delegated role. Without this root handoff, the planner prompt asks it to run
 * `handoff finish` with no handoff id, and the observe loop can never receive
 * a business-terminal `run_finished` event.
 */
export function openRootHandoffForRun(
	paths: RunPaths,
	role: string,
	requirement: string,
): ReturnType<typeof openHandoff> {
	const body = `Goal: ${requirement}\n\n## Requirement\n\n${requirement}\n`;
	return openHandoff(paths, {
		role,
		depth: 0,
		body,
		title: requirement.split("\n", 1)[0].slice(0, 80),
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

function appendTail(current: string, chunk: string): string {
	const next = current + chunk;
	return next.length > ROOT_OUTPUT_DIAGNOSTIC_LIMIT
		? next.slice(next.length - ROOT_OUTPUT_DIAGNOSTIC_LIMIT)
		: next;
}

function observeRootJsonLine(line: string, observation: RootOutputObservation): void {
	let event: any;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	if (event.type !== "message_end" || event.message?.role !== "assistant") return;
	if (event.message.stopReason) observation.stopReason = event.message.stopReason;
	if (event.message.errorMessage) observation.errorMessage = event.message.errorMessage;
}

async function drainRootStream(
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
		if (text) onChunk(text);
		buffer += text;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) onLine(line);
	}
	buffer += decoder.decode();
	if (buffer.trim()) onLine(buffer);
}

interface ParsedRun {
	role?: string;
	prompt: string;
	printOnly: boolean;
	handoffFile?: string;
}

interface RunOptions {
	resume?: ResumeSource;
}

function parseDelegate(argv: string[]): ParsedRun {
	let role: string | undefined;
	let handoffFile: string | undefined;
	let printOnly = false;
	const prompt: string[] = [];

	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		// `--role` is the spelling the inner vocabulary uses; `--agent` stays
		// accepted so a role prompt or script from before the split still works.
		if (token === "--role" || token === "--agent") {
			role = argv[++index];
		} else if (token === "--handoff-file") {
			handoffFile = argv[++index];
		} else if (token === "--print") {
			printOnly = true;
		} else {
			prompt.push(token);
		}
	}
	return { role, prompt: prompt.join(" "), printOnly, handoffFile };
}

function parseRoot(argv: string[], command: "exec" | "resume"): ParsedRun | { error: string } {
	const prompt: string[] = [];
	for (const token of argv) {
		if (token === "--role" || token === "--agent") {
			return { error: `${token} is a delegate-only role option; ${command} always starts the planner` };
		}
		if (token === "--handoff-file") {
			return { error: `${token} is delegate-only; handoff state belongs to code-agent delegate` };
		}
		if (token === "--print") {
			return { error: `--print is delegate-only; ${command} starts the planner and follows the run` };
		}
		if (token.startsWith("--")) return { error: `unknown ${command} option: ${token}` };
		prompt.push(token);
	}
	return { role: "planner", prompt: prompt.join(" "), printOnly: false, handoffFile: undefined };
}

/**
 * `entry` only changes how arguments are validated and reported.
 *
 * `exec` takes a requirement and always drives the planner: choosing the role
 * is the planner's job, not the caller's. `delegate` takes an explicit role
 * because that is precisely the decision the planner is making.
 */
export async function run(
	argv: string[],
	entry: "exec" | "resume" | "delegate" = "delegate",
	options: RunOptions = {},
): Promise<number> {
	const parsed = entry === "delegate" ? parseDelegate(argv) : parseRoot(argv, entry);
	if ("error" in parsed) return fail(parsed.error, entry);
	const args = parsed;

	if (entry !== "delegate") {
		if (args.prompt.trim() === "") {
			return fail(entry === "exec" ? "exec requires a requirement" : "resume requires a prompt", entry);
		}
		args.role ??= "planner";
	}
	if (!args.role) return fail("delegate requires --role ROLE", "delegate");

	let resolved;
	try {
		resolved = resolveRole(ROLES_FILE, args.role);
	} catch (error) {
		if (error instanceof RoleError) return fail(error.message, entry);
		throw error;
	}
	if (resolved === null) return fail(`unknown role: ${args.role}`, entry);

	const inherited = process.env.CODEFLOW_RUN_ID;
	const freshRun = options.resume !== undefined || inherited === undefined;
	const runId = options.resume?.runId ?? inherited ?? newRunId();
	const runsDir = resolveRunsDir(process.env.CODEFLOW_RUNS_DIR);
	let handoffId = process.env.CODEFLOW_HANDOFF_ID;

	// --print resolves the binding and exits. It must not register a run, emit
	// events, or create directories: a diagnostic that leaves artifacts behind
	// teaches people to ignore artifacts.
	if (args.printOnly) {
		console.log(
			JSON.stringify({
				role: args.role,
					env: {
						CODEFLOW_AGENT_ROLE: args.role,
						CODEFLOW_AGENT_DEPTH: freshRun ? "0" : "1",
						CODEFLOW_RUN_ID: runId,
						CODEFLOW_RUNS_DIR: runsDir,
						...(handoffId ? { CODEFLOW_HANDOFF_ID: handoffId } : {}),
					},
				argv: buildArgv(resolved, args.prompt, EXTENSIONS),
			}),
		);
		return 0;
	}

	const paths = new RunPaths(runsDir, runId);

	if (args.handoffFile) {
		if (!fs.existsSync(args.handoffFile)) {
			return fail(`handoff body not found: ${args.handoffFile}`, entry);
		}
		const opened = openHandoff(paths, {
			role: args.role,
			depth: 0,
			body: fs.readFileSync(args.handoffFile, "utf-8"),
		});
		handoffId = opened.handoff_id;
	}

	// The requirement is recorded with the run so `ls` can label it without
	// reading anything from inside the execute loop.
	if (freshRun) {
		const requirement = options.resume?.requirement ?? args.prompt;
		if (options.resume) runResume(paths, args.role, process.pid);
		else runStart(paths, args.role, process.pid, requirement);
		const root = openRootHandoffForRun(paths, args.role, requirement);
		handoffId = root.handoff_id;
	}

	console.error(
		`codeflow run_id=${runId} run_dir=${paths.runDir} handoff_id=${handoffId ?? "-"}` +
			(options.resume ? " resumed=true" : ""),
	);

	let child: Bun.Subprocess | undefined;
	let escalation: ReturnType<typeof setTimeout> | undefined;
	const terminateChild = (signal: "SIGTERM" | "SIGKILL"): void => {
		if (child?.pid === undefined) return;
		try {
			process.kill(-child.pid, signal);
		} catch {
			try {
				child.kill(signal);
			} catch {
				// The child is already gone.
			}
		}
	};
	const onTermination = (): void => {
		terminateChild("SIGTERM");
		if (escalation) clearTimeout(escalation);
		escalation = setTimeout(() => terminateChild("SIGKILL"), 5_000);
	};
	if (freshRun) {
		process.on("SIGTERM", onTermination);
		process.on("SIGINT", onTermination);
	}

	fs.mkdirSync(paths.piSessions, { recursive: true });
	const captureRootOutput = (entry === "exec" || entry === "resume") && freshRun;
	const rootObservation: RootOutputObservation = { stdoutTail: "", stderrTail: "" };
	child = Bun.spawn(
		buildArgv(resolved, args.prompt, EXTENSIONS, {
			id: `${runId}-planner`,
			dir: paths.piSessions,
		}),
		{
			stdin: captureRootOutput ? "ignore" : "inherit",
			stdout: captureRootOutput ? "pipe" : "inherit",
			stderr: captureRootOutput ? "pipe" : "inherit",
			detached: freshRun,
			env: {
				...process.env,
				PATH: `${path.join(RUNTIME_DIR, "bin")}:${process.env.PATH ?? ""}`,
				PI_CODING_AGENT_DIR: RUNTIME_DIR,
				CODEFLOW_AGENT_ROLE: args.role,
				CODEFLOW_AGENT_DEPTH: freshRun ? "0" : "1",
				CODEFLOW_RUN_ID: runId,
				CODEFLOW_RUNS_DIR: runsDir,
				...(handoffId ? { CODEFLOW_HANDOFF_ID: handoffId } : {}),
			},
		},
	);
	if (freshRun && child.pid !== undefined) runnerChildStarted(paths, child.pid);
	const rootOutputDrained = captureRootOutput
		? Promise.all([
				drainRootStream(
					child.stdout,
					(line) => observeRootJsonLine(line, rootObservation),
					(chunk) => {
						rootObservation.stdoutTail = appendTail(rootObservation.stdoutTail, chunk);
					},
				),
				drainRootStream(
					child.stderr,
					() => undefined,
					(chunk) => {
						rootObservation.stderrTail = appendTail(rootObservation.stderrTail, chunk);
					},
				),
			])
		: undefined;

	const code = await child.exited;
	if (rootOutputDrained) await rootOutputDrained;
	if (escalation) clearTimeout(escalation);
	if (captureRootOutput && (code !== 0 || rootObservation.stopReason === "error")) {
		const tail = (
			rootObservation.errorMessage ??
			(rootObservation.stderrTail || rootObservation.stdoutTail)
		)
			.trim()
			.slice(-2_000);
		console.error(
			`codeflow ${entry}: planner exited with code ${code}${tail ? `; diagnostic tail:\n${tail}` : ""}`,
		);
	}

	// The watchdog may have missed the exit; recording it here is what lets an
	// outer loop distinguish "finished" from "died without finishing".
	try {
		runnerExited(paths, child.pid, args.role, freshRun ? 0 : 1);
	} catch {
		// Never let bookkeeping mask the child's exit code.
	}

	try {
		const summary = writeUsageSummary(paths);
		if (freshRun) {
			console.error(`codeflow usage_summary=${summary}`);
			console.error(renderUsageSummary(JSON.parse(fs.readFileSync(summary, "utf8"))));
		}
	} catch {
		// Usage observability must not turn a completed product run into a
		// nonzero exit. The append-only ledger remains available for diagnosis.
	}

	return code;
}

async function resume(argv: string[]): Promise<number> {
	if (argv.length === 0) return fail("resume requires a run id", "resume");
	if (argv.length > 1) return fail(`unexpected argument: ${argv[1]}`, "resume");
	if (argv[0].startsWith("--")) return fail(`unknown option: ${argv[0]}`, "resume");
	if (process.env.CODEFLOW_RUN_ID) {
		return fail("resume is an outer command and cannot run inside another Codeflow run", "resume");
	}

	const runsDir = resolveRunsDir(process.env.CODEFLOW_RUNS_DIR);
	try {
		const source = loadResumeSource(runsDir, argv[0]);
		const prompt =
			`Resume Codeflow run ${source.runId} after an external correction. ` +
			"Continue its existing immutable goals and latest lane state; preserve completed evidence and do not recreate satisfied work.\n\n" +
			`Original requirement:\n${source.requirement}`;
		return await run([prompt], "resume", { resume: source });
	} catch (error) {
		if (error instanceof ResumeError) return fail(error.message, "resume");
		throw error;
	}
}

function debug(argv: string[]): number {
	const [sub, name] = argv;
	if (sub === "agent") {
		if (!name) {
			for (const role of listRoles(ROLES_FILE)) console.log(role);
			return 0;
		}
		const definition = readRoleDefinition(ROLES_FILE, name);
		if (definition === null) return fail(`unknown agent: ${name}`);
		console.log(`agent: ${name}`);
		console.log(`description: ${definition.description}`);
		console.log(`model: ${definition.model}`);
		console.log(`prompt: ${definition.prompt}`);
		if (definition.tools) console.log(`tools: ${definition.tools.join(",")}`);
		if (definition.delegates) console.log(`delegates: ${definition.delegates}`);
		return 0;
	}
	if (sub === "skill") {
		const skills = path.join(RUNTIME_DIR, "skills");
		try {
			for (const entry of fs.readdirSync(skills, { withFileTypes: true }).sort()) {
				if (entry.isDirectory()) console.log(entry.name);
			}
		} catch {
			return fail(`skills directory not found: ${skills}`);
		}
		return 0;
	}
	return fail("debug requires a subcommand: agent | skill");
}

export async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	switch (command) {
		case "exec":
			return await run(rest, "exec");
		case "resume":
			return await resume(rest);
		case "delegate":
			return await run(rest, "delegate");
		case "debug":
			return debug(rest);
		case "--version":
			console.log(VERSION);
			return 0;
		default:
			return fail("usage: <exec|resume|delegate|debug> ...");
	}
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
