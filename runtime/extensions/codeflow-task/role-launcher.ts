/**
 * Role resolution and isolated Pi child launcher.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { eventLogExcerpt } from "../../lib/events";
import { immediateFailureReasons, STREAM_IDLE_ABORT_MARKER } from "./handoff-gate";
import { finishBlocked } from "./registry";
import type { GoalTaskRef } from "./registry";
import { currentRun, type RoleRunResult } from "./shared";

// runtime/extensions/codeflow-task/role-launcher.ts -> runtime
const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENTS_DIR = path.join(RUNTIME_DIR, "agents");
const WATCHDOG_EXTENSION = path.join(RUNTIME_DIR, "extensions", "agent-watchdog", "index.ts");
const CONTEXT_EXTENSION = path.join(RUNTIME_DIR, "extensions", "codeflow-context", "index.ts");
const BASH_COMPRESSOR_EXTENSION = path.join(RUNTIME_DIR, "extensions", "bash-compressor", "index.ts");
const USAGE_LEDGER_EXTENSION = path.join(RUNTIME_DIR, "extensions", "usage-ledger", "index.ts");
const HOST_GUARD_EXTENSION = path.join(RUNTIME_DIR, "extensions", "host-guard", "index.ts");
const ROLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const INTERNAL_ROLES = new Set(["zipper"]);

export interface TaskDetails {
	agent: string;
	exitCode: number;
	stopReason?: string;
	stderr: string;
	handoffId?: string;
	handoffStatus?: string;
	goalId?: string;
	lane?: string;
	sessionId?: string;
}

interface ResolvedRole {
	provider: string;
	model: string;
	tools: string[];
	body: string;
}

function listAvailableRoles(): string {
	if (!fs.existsSync(AGENTS_DIR)) return "none";
	const roles = fs
		.readdirSync(AGENTS_DIR)
		.filter((name) => name.endsWith(".md"))
		.map((name) => name.slice(0, -3))
		.filter((name) => !INTERNAL_ROLES.has(name))
		.sort();
	return roles.length > 0 ? roles.join(", ") : "none";
}

const delegatesCache = new Map<string, boolean>();

export function roleMayDelegate(role: string | undefined, depth: number): boolean {
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
	if (INTERNAL_ROLES.has(role)) {
		return {
			ok: false,
			role,
			error: `Role "${role}" is internal support and cannot receive project handoffs.`,
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
 * Spawn one pi child for a role and collect its final assistant text.
 * On signal abort the child is killed (SIGTERM, then SIGKILL) so no orphan
 * process is left running.
 */
export async function runRoleChild(
	agent: string,
	prompt: string,
	signal: AbortSignal | undefined,
	cwd: string,
	handoffId?: string,
	session?: { id: string; dir: string },
	goal?: GoalTaskRef,
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
	if (fs.existsSync(CONTEXT_EXTENSION)) args.push("--extension", CONTEXT_EXTENSION);
	if (fs.existsSync(BASH_COMPRESSOR_EXTENSION)) {
		args.push("--extension", BASH_COMPRESSOR_EXTENSION);
	}
	if (fs.existsSync(USAGE_LEDGER_EXTENSION)) {
		args.push("--extension", USAGE_LEDGER_EXTENSION);
	}
	if (fs.existsSync(HOST_GUARD_EXTENSION)) {
		args.push("--extension", HOST_GUARD_EXTENSION);
	}
	if (resolved.tools.length > 0) args.push("--tools", resolved.tools.join(","));
	args.push("-p", prompt);
	if (session) {
		fs.mkdirSync(session.dir, { recursive: true });
		args.push("--session-id", session.id, "--session-dir", session.dir);
	} else {
		args.push("--no-session");
	}

	const childEnv: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: RUNTIME_DIR,
		CODEFLOW_AGENT_ROLE: role,
		CODEFLOW_AGENT_DEPTH: "1",
	};
	if (handoffId) childEnv.CODEFLOW_HANDOFF_ID = handoffId;
	else delete childEnv.CODEFLOW_HANDOFF_ID;
	if (goal) {
		childEnv.CODEFLOW_GOAL_ID = goal.goalId;
		childEnv.CODEFLOW_LANE = goal.lane;
	} else {
		delete childEnv.CODEFLOW_GOAL_ID;
		delete childEnv.CODEFLOW_LANE;
	}

	let buffer = "";
	let finalText = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let wasAborted = false;

	/**
	 * A terminal provider signal is state, not prose. Publishing it before the
	 * process closes removes the quota/transport failure window in which the
	 * outer loop would otherwise continue waiting while the provider has already
	 * failed. The event carries only a bounded, redacted head/tail log excerpt.
	 */
	function publishImmediateFailure(
		observedStopReason: string | undefined,
		watchdogAborted: boolean,
		fallbackSummary: string,
	): void {
		if (!handoffId) return;
		const paths = currentRun();
		const reasons = immediateFailureReasons({
			stopReason: observedStopReason,
			watchdogAborted,
			receiptPresent: paths ? fs.existsSync(paths.receiptPath(handoffId)) : false,
		});
		if (reasons.length === 0) return;
		const summary =
			eventLogExcerpt(errorMessage || stderr.text || finalText) || fallbackSummary;
		finishBlocked(handoffId, reasons, summary, cwd, summary);
	}

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
			if (message.stopReason === "error") {
				publishImmediateFailure(
					message.stopReason,
					false,
					"provider request ended with error",
				);
			} else if (message.stopReason === "length") {
				publishImmediateFailure(
					message.stopReason,
					false,
					"provider response reached the output limit",
				);
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
			if (stderr.text.includes(STREAM_IDLE_ABORT_MARKER)) {
				publishImmediateFailure(
					stopReason,
					true,
					"stream idle watchdog aborted the provider request",
				);
			}
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
				errorMessage,
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
				errorMessage,
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
				errorMessage,
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
