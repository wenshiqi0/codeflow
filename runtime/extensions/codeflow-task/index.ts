/**
 * Codeflow task role launcher.
 *
 * Registers `task(agent, prompt)` and `task_group(tasks, max_concurrency)`
 * tools only on depth-0 roles whose frontmatter declares `delegates: true`.
 * Each
 * call spawns isolated `pi` children in JSON mode whose system prompt is the
 * Markdown body of `.codeflow/agents/<role>.md`, discovered by filename.
 * Frontmatter is parsed with Pi's parseFrontmatter; `model` must be
 * "<provider>/<model>", while `description`, `tools`, and the strict boolean
 * `delegates` permission are optional. The Markdown agent files are the sole
 * source of truth for role identity.
 *
 * Every delegation is also a handoff. Before the child starts, the prompt is
 * registered as `handoffs/<id>/handoff.md` and the id is injected into the
 * child's environment so the child can write its own receipt through
 * `codeflow handoff finish`. Afterwards this extension checks mechanically
 * that a terminal receipt landed; when it did not, it records `blocked` with
 * the observable reasons rather than retrying. The tool's return value is a
 * pointer, so a receipt body never enters the delegator's context.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { blockedReasons, delegationPointer, STREAM_IDLE_ABORT_MARKER } from "./handoff-gate";
import {
	finishHandoff as finishHandoffState,
	openHandoff as openHandoffState,
} from "../../lib/handoff";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";

// runtime/extensions/codeflow-task/index.ts -> runtime
const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENTS_DIR = path.join(RUNTIME_DIR, "agents");
const WATCHDOG_EXTENSION = path.join(RUNTIME_DIR, "extensions", "agent-watchdog", "index.ts");
const ROLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_CONCURRENCY = 8;

interface OpenedHandoff {
	handoffId: string;
	statePath: string;
	receiptPath: string;
}

/** Resolve the run paths for the run this process belongs to. */
function currentRun(): RunPaths | null {
	const runId = process.env.CODEFLOW_RUN_ID;
	if (!runId) return null;
	return new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, runId);
}

/**
 * Register the delegation as a handoff. Returns null when there is no run to
 * record against (for example `pi` started by hand), so delegation keeps
 * working without a registry rather than failing.
 */
function openHandoff(role: string, prompt: string, cwd: string): OpenedHandoff | null {
	const paths = currentRun();
	if (!paths) return null;
	try {
		const opened = openHandoffState(paths, {
			role,
			body: prompt,
			depth: 1,
			parentId: process.env.CODEFLOW_HANDOFF_ID ?? null,
		});
		return {
			handoffId: opened.handoff_id,
			statePath: opened.state,
			receiptPath: opened.receipt,
		};
	} catch {
		return null;
	}
}

function readHandoffState(statePath: string): { status?: string; result?: string } {
	try {
		const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
		return { status: state.status, result: state.result };
	} catch {
		return {};
	}
}

function finishBlocked(handoffId: string, reasons: string[], summary: string, cwd: string): void {
	const paths = currentRun();
	if (!paths) return;
	try {
		finishHandoffState(paths, {
			handoffId,
			status: "BLOCKED",
			summary,
			blockedReasons: reasons,
		});
	} catch {
		// A handoff the child already finished is terminal and immutable; the
		// rejection is expected and must not mask the child's own verdict.
	}
}

/**
 * Reconcile what the child left behind with what the contract requires.
 *
 * Receipt *schema* validation already happened inside the CLI when the child
 * wrote it, so there is exactly one implementation of the schema; here the
 * check is existence. A handoff the child already finished is terminal and
 * immutable — the parent reports it and never rewrites it.
 */
function reconcileHandoff(
	handoff: OpenedHandoff,
	result: RoleRunResult,
	cwd: string,
): { status: string; reasons: string[]; receipt: string | null } {
	const receiptPresent = fs.existsSync(handoff.receiptPath);
	const reasons = blockedReasons({
		exitCode: result.exitCode,
		stopReason: result.stopReason,
		aborted: result.aborted,
		watchdogAborted: result.stderr.includes(STREAM_IDLE_ABORT_MARKER),
		receiptPresent,
	});
	const recorded = readHandoffState(handoff.statePath);
	if (recorded.status === "done" || recorded.status === "blocked") {
		return {
			status: recorded.status === "blocked" ? "BLOCKED" : recorded.result ?? "PASS",
			reasons: recorded.status === "blocked" ? reasons : [],
			receipt: receiptPresent ? handoff.receiptPath : null,
		};
	}
	if (reasons.length === 0) reasons.push("DELEGATION_ARTIFACT_MISSING");
	finishBlocked(handoff.handoffId, reasons, result.content.slice(0, 400), cwd);
	return {
		status: "BLOCKED",
		reasons,
		receipt: receiptPresent ? handoff.receiptPath : null,
	};
}

interface TaskDetails {
	agent: string;
	exitCode: number;
	stopReason?: string;
	stderr: string;
	handoffId?: string;
	handoffStatus?: string;
}

interface ResolvedRole {
	provider: string;
	model: string;
	tools: string[];
	body: string;
}

interface RoleRunResult {
	agent: string;
	success: boolean;
	content: string;
	exitCode: number;
	stopReason?: string;
	stderr: string;
	aborted?: boolean;
}

function listAvailableRoles(): string {
	if (!fs.existsSync(AGENTS_DIR)) return "none";
	const roles = fs
		.readdirSync(AGENTS_DIR)
		.filter((name) => name.endsWith(".md"))
		.map((name) => name.slice(0, -3))
		.sort();
	return roles.length > 0 ? roles.join(", ") : "none";
}

const delegatesCache = new Map<string, boolean>();

function roleMayDelegate(role: string | undefined, depth: number): boolean {
	if (!role || depth !== 0 || !ROLE_NAME_PATTERN.test(role)) return false;
	const cached = delegatesCache.get(role);
	if (cached !== undefined) return cached;
	const agentPath = path.join(AGENTS_DIR, `${role}.md`);
	if (!fs.existsSync(agentPath)) return false;
	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(
		fs.readFileSync(agentPath, "utf-8"),
	);
	const result = frontmatter.delegates === true;
	delegatesCache.set(role, result);
	return result;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

function resolveRole(agent: string): { ok: true; role: string; resolved: ResolvedRole } | { ok: false; role: string; error: string } {
	const role = agent.trim();
	if (!ROLE_NAME_PATTERN.test(role)) {
		return {
			ok: false,
			role,
			error: `Invalid role name: "${agent}". Roles are discovered by filename in .codeflow/agents/.`,
		};
	}

	const agentPath = path.join(AGENTS_DIR, `${role}.md`);
	if (!fs.existsSync(agentPath)) {
		return { ok: false, role, error: `Unknown role: "${role}". Available roles: ${listAvailableRoles()}.` };
	}

	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(
		fs.readFileSync(agentPath, "utf-8"),
	);

	const modelValue = String(frontmatter.model ?? "");
	const [provider, model] = modelValue.split("/");
	if (!provider || !model) {
		return {
			ok: false,
			role,
			error: `Role "${role}" is invalid: frontmatter model must be "<provider>/<model>", got "${modelValue}".`,
		};
	}

	const tools = String(frontmatter.tools ?? "")
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);

	return { ok: true, role, resolved: { provider, model, tools, body } };
}

/**
 * Spawn one isolated pi child for a role and collect its final assistant text.
 * On signal abort the child is killed (SIGTERM, then SIGKILL) so no orphan
 * process is left running.
 */
async function runRoleChild(
	agent: string,
	prompt: string,
	signal: AbortSignal | undefined,
	cwd: string,
	handoffId?: string,
): Promise<RoleRunResult> {
	const resolution = resolveRole(agent);
	if (!resolution.ok) {
		return { agent: resolution.role, success: false, content: resolution.error, exitCode: 1, stderr: "" };
	}
	const { role, resolved } = resolution;
	const stderr = { text: "" };

	const args = [
		"--mode",
		"json",
		"--no-session",
		"--provider",
		resolved.provider,
		"--model",
		resolved.model,
		"--system-prompt",
		resolved.body,
	];
	// A delegated child is a pi process too, so it needs the same liveness
	// coverage as depth 0; without it a SIGKILLed child leaves no trace.
	if (fs.existsSync(WATCHDOG_EXTENSION)) args.push("--extension", WATCHDOG_EXTENSION);
	if (resolved.tools.length > 0) args.push("--tools", resolved.tools.join(","));
	args.push("-p", prompt);

	const childEnv: Record<string, string | undefined> = {
		...process.env,
		CODEFLOW_AGENT_ROLE: role,
		CODEFLOW_AGENT_DEPTH: "1",
	};
	if (handoffId) childEnv.CODEFLOW_HANDOFF_ID = handoffId;
	else delete childEnv.CODEFLOW_HANDOFF_ID;

	let buffer = "";
	let finalText = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let wasAborted = false;

	const processLine = (line: string) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let event: any;
		try {
			event = JSON.parse(trimmed);
		} catch {
			return;
		}
		if (event.type === "message_end" && event.message) {
			const message = event.message;
			if (message.role !== "assistant") return;
			if (message.stopReason) stopReason = message.stopReason;
			if (message.errorMessage) errorMessage = message.errorMessage;
			for (const part of message.content ?? []) {
				if (part.type === "text") finalText = part.text;
			}
		}
	};

	const exitCode = await new Promise<number>((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let childClosed = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		const killProc = () => {
			wasAborted = true;
			proc.kill("SIGTERM");
			killTimer = setTimeout(() => {
				if (!childClosed && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
			}, 5000);
		};

		const cleanup = () => {
			childClosed = true;
			if (killTimer) clearTimeout(killTimer);
			if (signal) signal.removeEventListener("abort", killProc);
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => {
			stderr.text += data.toString();
		});
		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			cleanup();
			resolve(code ?? 1);
		});
		proc.on("error", (error) => {
			stderr.text += String(error);
			cleanup();
			resolve(1);
		});

		if (signal) {
			if (signal.aborted) killProc();
			else signal.addEventListener("abort", killProc, { once: true });
		}
	});

	if (wasAborted) {
		return {
			agent: role,
			success: false,
			content: `Task for role "${role}" was aborted by cancellation.`,
			exitCode,
			stopReason,
			stderr: stderr.text,
			aborted: true,
		};
	}
	if (exitCode !== 0) {
		const tail = stderr.text.trim().split("\n").slice(-5).join("\n");
		return {
			agent: role,
			success: false,
			content: `Role "${role}" exited with nonzero code ${exitCode}.${tail ? `\n${tail}` : ""}`,
			exitCode,
			stopReason,
			stderr: stderr.text,
		};
	}
	if (stopReason === "error" || stopReason === "aborted" || stopReason === "length") {
		return {
			agent: role,
			success: false,
			content: `Role "${role}" stopped with reason "${stopReason}"${errorMessage ? `: ${errorMessage}` : ""}`,
			exitCode,
			stopReason,
			stderr: stderr.text,
		};
	}

	return {
		agent: role,
		success: true,
		content: finalText || "(no output)",
		exitCode,
		stopReason,
		stderr: stderr.text,
	};
}

const TaskParams = Type.Object({
	agent: Type.String({ description: "Codeflow role name; resolved to agents/<role>.md by filename" }),
	prompt: Type.String({ description: "Task prompt handed to the role" }),
});

const TaskGroupParams = Type.Object({
	tasks: Type.Array(
		Type.Object({
			agent: Type.String({ description: "Codeflow role name" }),
			prompt: Type.String({ description: "Task prompt for the role" }),
		}),
	),
	max_concurrency: Type.Optional(
		Type.Number({ description: "Maximum concurrent children (default 3, minimum 1, maximum 8)" }),
	),
});

export default function (pi: ExtensionAPI) {
	// Delegation is an explicit role permission and is available only at depth
	// 0. Children always run at depth 1, so they can never re-register tools
	// even if their role frontmatter also contains `delegates: true`.
	const role = process.env.CODEFLOW_AGENT_ROLE;
	const depth = Number(process.env.CODEFLOW_AGENT_DEPTH ?? "0");
	if (!roleMayDelegate(role, depth)) return;

	pi.registerTool({
		name: "task",
		label: "Task",
		description:
			"Delegate a task to a Codeflow role defined in .codeflow/agents/<role>.md. " +
			"The role runs in an isolated pi child process with its own context.",
		parameters: TaskParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<TaskDetails>> {
			const agent = params.agent.trim();
			const details: TaskDetails = { agent, exitCode: 1, stderr: "" };
			const fail = (text: string): AgentToolResult<TaskDetails> => ({
				content: [{ type: "text", text }],
				details,
				isError: true,
			});

			const handoff = openHandoff(agent, params.prompt, ctx.cwd);
			const result = await runRoleChild(
				agent,
				params.prompt,
				signal,
				ctx.cwd,
				handoff?.handoffId,
			);
			details.agent = result.agent;
			details.exitCode = result.exitCode;
			details.stopReason = result.stopReason;
			details.stderr = result.stderr;
			details.handoffId = handoff?.handoffId;

			// Without a registry there is no pointer to return, so the child's
			// text stays the result; this is the unregistered fallback path.
			if (!handoff) {
				return result.success
					? { content: [{ type: "text", text: result.content }], details }
					: fail(result.content);
			}

			const reconciled = reconcileHandoff(handoff, result, ctx.cwd);
			details.handoffStatus = reconciled.status;
			const pointer = delegationPointer(
				handoff.handoffId,
				reconciled.status,
				reconciled.reasons,
				reconciled.receipt,
				handoff.statePath,
			);
			const text = JSON.stringify(pointer);
			return reconciled.status === "PASS"
				? { content: [{ type: "text", text }], details }
				: { content: [{ type: "text", text }], details, isError: true };
		},
	});

	pi.registerTool({
		name: "task_group",
		label: "Task Group",
		description:
			"Run multiple independent Codeflow role tasks concurrently with bounded " +
			"concurrency. Each task spawns an isolated pi child like the task tool. " +
			"Results are reported as a JSON array in input order, one entry per task " +
			"with agent, success, content, and exitCode.",
		parameters: TaskGroupParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult> {
			const tasks = params.tasks;
			const maxConcurrent = Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(params.max_concurrency ?? 3)));
			const results: Array<Record<string, unknown>> = new Array(tasks.length);
			let wasAborted = false;
			const abortListener = () => { wasAborted = true; };
			if (signal) {
				if (signal.aborted) wasAborted = true;
				else signal.addEventListener("abort", abortListener);
			}

			// Bounded worker pool: at most maxConcurrent children run at a time.
			// The shared cursor hands out input indexes so results[i] always
			// preserves the original task order.
			let cursor = 0;
			const worker = async () => {
				while (true) {
					const index = cursor++;
					if (index >= tasks.length) return;
					const task = tasks[index];
					if (signal?.aborted) {
						results[index] = {
							agent: task.agent.trim(),
							success: false,
							content: "Task was aborted by cancellation before it started.",
							exitCode: 1,
						};
						continue;
					}
					const handoff = openHandoff(task.agent.trim(), task.prompt, ctx.cwd);
					const result = await runRoleChild(
						task.agent,
						task.prompt,
						signal,
						ctx.cwd,
						handoff?.handoffId,
					);
					if (!handoff) {
						results[index] = {
							agent: result.agent,
							success: result.success,
							content: result.content,
							exitCode: result.exitCode,
						};
						continue;
					}
					const reconciled = reconcileHandoff(handoff, result, ctx.cwd);
					results[index] = {
						agent: result.agent,
						...delegationPointer(
							handoff.handoffId,
							reconciled.status,
							reconciled.reasons,
							reconciled.receipt,
							handoff.statePath,
						),
					};
				}
			};

			const workers: Array<Promise<void>> = [];
			for (let i = 0; i < Math.min(maxConcurrent, tasks.length); i++) {
				workers.push(worker());
			}

			try {
				await Promise.all(workers);
			} finally {
				signal?.removeEventListener("abort", abortListener);
				// Orphan prevention: every child registers an abort listener that
				// kills its process, and runRoleChild only resolves after the
				// child closed, so reaching this point means no child is left
				// running. If the signal aborted mid-flight, kill propagation
				// already happened inside runRoleChild.
			}

			if (wasAborted) {
				return {
					content: [
						{
							type: "text",
							text: "task_group was aborted by cancellation; running children were killed.",
						},
					],
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
			};
		},
	});
}
