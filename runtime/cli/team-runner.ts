#!/usr/bin/env bun
/** One fenced, serial assignment in a durable Pi Agent session. */
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_TOOL_ALLOWLIST, agentExtensions } from "../lib/agent-launch";
import { buildAgentArgv, resolveAgent } from "../lib/config";
import { commitmentHistory, recordRuntimeFailure, type RuntimeFailureReason } from "../lib/commitment";
import { loadWorkerReport, recordExecutionFailure } from "../lib/executions";
import { RunPaths } from "../lib/paths";
import { CONTEXT_BUDGET_ABORT_MARKER } from "../lib/runtime-signals";
import { attachAgentProcess, beginAgentExecution, completeAgentExecution, loadTeam, type TeamAgent } from "../lib/team";
import { reapTeamTools } from "../lib/team-tools";

const RUNTIME_DIR = path.resolve(import.meta.dir, "..");
const DIAGNOSTIC_LIMIT = 8_000;

/** Read only the public header, never the Agent's conversation or reasoning. */
export function validateAgentSession(agent: Pick<TeamAgent, "mode" | "session_path">, projectDir: string): void {
	if (!path.isAbsolute(agent.session_path)) throw new Error("Agent session path must be absolute");
	if (agent.mode !== "followup") {
		if (fs.existsSync(agent.session_path)) throw new Error("A new or fresh-resume Agent session must not already exist");
		return;
	}
	if (!fs.lstatSync(agent.session_path).isFile()) throw new Error("Agent session must be a regular file");
	const descriptor = fs.openSync(agent.session_path, "r");
	try {
		const buffer = Buffer.alloc(65_536);
		const size = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
		const newline = buffer.indexOf(10, 0);
		if (newline < 0 || newline >= size) throw new Error("Agent session has no complete bounded header");
		const header = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
		if (header.type !== "session" || typeof header.id !== "string" || !header.id
			|| typeof header.cwd !== "string" || !path.isAbsolute(header.cwd)) {
			throw new Error("Agent session header is invalid");
		}
		// Pi deliberately restores its cwd from the header, overriding process.cwd().
		if (fs.realpathSync(header.cwd) !== fs.realpathSync(projectDir)) {
			throw new Error("Agent session belongs to a different project directory");
		}
	} finally {
		fs.closeSync(descriptor);
	}
}

export interface AgentExitObservation {
	exitCode: number | null;
	stopReason?: string;
	diagnostics: string;
	cancelled: boolean;
	launchFailed?: boolean;
}

export function agentExitReasons(observation: AgentExitObservation): RuntimeFailureReason[] {
	if (observation.diagnostics.includes(CONTEXT_BUDGET_ABORT_MARKER)) return ["CONTEXT_BUDGET_EXCEEDED"];
	if (observation.launchFailed) return ["WORKER_LAUNCH_FAILURE"];
	const reasons: RuntimeFailureReason[] = [];
	if (observation.cancelled || observation.stopReason === "aborted") reasons.push("USER_CANCELLED");
	if (observation.stopReason === "length") reasons.push("OUTPUT_TRUNCATED");
	if (observation.diagnostics.includes("CODEFLOW_EXECUTION_TIMEOUT")) reasons.push("EXECUTION_TIMEOUT");
	if (observation.exitCode !== 0 || observation.stopReason === "error") reasons.push("PROVIDER_FAILURE");
	return [...new Set(reasons)];
}

/** A process exit is not semantic completion; every owned Claim needs a Receipt. */
export function classifyAgentCompletion(paths: RunPaths, agent: Pick<TeamAgent, "execution_id" | "resume_commitment_id">,
	observation: AgentExitObservation) {
	const commitments = commitmentHistory(paths).filter((view) =>
		view.commitment.worker_execution_id === agent.execution_id
		|| view.commitment.id === agent.resume_commitment_id);
	const reasons = agentExitReasons(observation);
	const preclaimReport = commitments.length === 0 ? loadWorkerReport(paths, agent.execution_id) : null;
	if (commitments.length === 0 && !preclaimReport) reasons.push("COMMITMENT_CLAIM_MISSING");
	else if (commitments.some((view) => !view.folded.terminal)) reasons.push("TERMINAL_RECEIPT_MISSING");
	return { status: reasons.length ? "interrupted" as const : "idle" as const,
		reasons: [...new Set(reasons)], commitments };
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
	try { process.kill(-pid, signal); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

export async function runTeamAgent(paths: RunPaths, agentId: string, executionId: string): Promise<number> {
	// A stale or duplicate runner must fail before touching a session or subprocess.
	const agent = await beginAgentExecution(paths, agentId, executionId, process.pid);
	const observation: AgentExitObservation = { exitCode: null, diagnostics: "", cancelled: false };
	let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let cleanupFailure: unknown;
	const signalHandlers = new Map<NodeJS.Signals, () => void>();
	const appendDiagnostic = (text: string) => {
		observation.diagnostics = (observation.diagnostics + text).slice(-DIAGNOSTIC_LIMIT);
	};
	const stop = () => {
		if (observation.cancelled) return;
		observation.cancelled = true;
		if (!child) return;
		// Pi handles TERM by disposing extensions and tracked detached bash groups.
		signalGroup(child.pid, "SIGTERM");
		killTimer = setTimeout(() => { if (child) signalGroup(child.pid, "SIGKILL"); }, 5_000);
	};
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
		signalHandlers.set(signal, stop);
		process.on(signal, stop);
	}
	try {
		const team = await loadTeam(paths);
		validateAgentSession(agent, team.project_dir);
		fs.mkdirSync(path.dirname(agent.session_path), { recursive: true });
		const resolved = resolveAgent(path.join(RUNTIME_DIR, "config.json"), team.model);
		const argv = buildAgentArgv(resolved,
			agent.mode === "resume"
				? "Continue your existing open Commitment from the current durable state. Execute and verify the assigned work, then report a Receipt."
				: "Read the current assignment and Goal, claim bounded work, execute and verify it, then report a Receipt. Previous assignments in this session are historical context, not current instructions.",
			agentExtensions(RUNTIME_DIR), AGENT_TOOL_ALLOWLIST);
		argv[0] = path.join(RUNTIME_DIR, "bin", "pi");
		argv.push("--session", agent.session_path);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PATH: `${path.join(RUNTIME_DIR, "bin")}:${process.env.PATH ?? ""}`,
			PI_CODING_AGENT_DIR: RUNTIME_DIR,
			CODEFLOW_RUN_ID: paths.runId,
			CODEFLOW_RUNS_DIR: path.resolve(paths.code),
			CODEFLOW_PROJECT_DIR: team.project_dir,
			CODEFLOW_EVIDENCE_DIR: paths.evidence,
			CODEFLOW_TEAM_AGENT_ID: agentId,
			CODEFLOW_TEAM_RUNNER_PID: String(process.pid),
			CODEFLOW_EXECUTION_ID: executionId,
			CODEFLOW_GOAL_ID: agent.goal_id,
			CODEFLOW_WORK_FOCUS: agent.focus,
			CODEFLOW_PROCESS_KIND: "worker",
			CODEFLOW_AGENT_MODEL: team.model,
		};
		delete env.CODEFLOW_PARENT_COMMITMENT_ID;
		delete env.CODEFLOW_COMMITMENT_ID;
		delete env.CODEFLOW_TEAM_SHELL_READY;
		if (agent.resume_commitment_id) env.CODEFLOW_COMMITMENT_ID = agent.resume_commitment_id;
		child = Bun.spawn(argv, { cwd: team.project_dir, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
		const processLine = (line: string) => {
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end" && event.message?.role === "assistant") {
					observation.stopReason = event.message.stopReason ?? observation.stopReason;
					if (event.message.errorMessage) appendDiagnostic(String(event.message.errorMessage));
				}
			} catch { /* Only public lifecycle events are relevant to completion. */ }
		};
		const output = (async () => {
			const decoder = new TextDecoder();
			let pending = "";
			for await (const chunk of child!.stdout) {
				process.stdout.write(chunk);
				pending += decoder.decode(chunk, { stream: true });
				const lines = pending.split("\n");
				pending = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			}
			pending += decoder.decode();
			if (pending.trim()) processLine(pending);
		})();
		const errors = (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of child!.stderr) {
				process.stderr.write(chunk);
				appendDiagnostic(decoder.decode(chunk, { stream: true }));
			}
			appendDiagnostic(decoder.decode());
		})();
		// Pi print mode waits for stdin EOF before invoking the first prompt. Keep
		// that gate closed until the outer reservation has the real subprocess PID.
		try {
			await attachAgentProcess(paths, agentId, executionId, child.pid);
			child.stdin.end();
		} catch (error) {
			observation.launchFailed = true;
			appendDiagnostic(String(error));
			signalGroup(child.pid, "SIGKILL");
		}
		observation.exitCode = await child.exited;
		// Reap the independently tracked Pi process group before waiting for pipes;
		// surviving inherited pipe owners must not deadlock completion/drain.
		signalGroup(child.pid, "SIGKILL");
		await reapTeamTools(paths, executionId);
		await Promise.all([output, errors]);
	} catch (error) {
		observation.launchFailed = true;
		appendDiagnostic(String(error));
		if (child) {
			signalGroup(child.pid, "SIGKILL");
			observation.exitCode = await child.exited;
		}
		try { await reapTeamTools(paths, executionId); }
		catch (error) { cleanupFailure = error; }
	} finally {
		if (killTimer) clearTimeout(killTimer);
		for (const [signal, handler] of signalHandlers) process.off(signal, handler);
	}
	if (cleanupFailure) {
		// Preserve the busy reservation and published identities. An outer stop
		// must confirm tool cleanup before this session or capacity can be reused.
		recordExecutionFailure(paths, executionId, agent.goal_id, ["WORKER_LAUNCH_FAILURE"], "Agent tool cleanup is unconfirmed; explicit stop and inspection required");
		throw cleanupFailure;
	}
	const completion = classifyAgentCompletion(paths, agent, observation);
	const summary = completion.status === "idle"
		? "Agent assignment ended with terminal Receipts or a durable pre-claim blocker report."
		: `Agent assignment interrupted: ${completion.reasons.join(", ")}.`;
	if (completion.status === "interrupted") {
		if (completion.commitments.length === 0) {
			recordExecutionFailure(paths, executionId, agent.goal_id, completion.reasons, summary);
		} else {
			for (const view of completion.commitments) {
				if (!view.folded.terminal) recordRuntimeFailure(paths, view.commitment.id, completion.reasons, summary);
			}
		}
	}
	await completeAgentExecution(paths, agentId, executionId, {
		status: completion.status, reasons: completion.reasons, summary, exit_code: observation.exitCode,
	});
	return completion.status === "idle" ? 0 : 1;
}

if (import.meta.main) {
	try {
		const [runsDir, taskId, agentId, executionId, ...extra] = process.argv.slice(2);
		if (!runsDir || !path.isAbsolute(runsDir) || !taskId || !agentId || !executionId || extra.length
			|| [taskId, agentId, executionId].some((value) => !/^[a-zA-Z0-9_-]+$/.test(value))) {
			throw new Error("usage: team-runner <absolute-runs-dir> <task-id> <agent-id> <execution-id>");
		}
		process.exitCode = await runTeamAgent(new RunPaths(runsDir, taskId), agentId, executionId);
	} catch (error) {
		console.error(`codeteam runner: ${String(error)}`);
		process.exitCode = 1;
	}
}
