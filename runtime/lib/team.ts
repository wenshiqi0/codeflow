/** Shared codeteam control plane. Caller identity does not change its capabilities. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { commitmentHistory, reconcileDeadCommitments, resumeCommitment, type RuntimeFailureReason } from "./commitment";
import { resolveAgent } from "./config";
import { createTask } from "./tasks";
import { createGoal, type CreateGoalOptions } from "./goals";
import { goalState } from "./state";
import { deliverEvent, eventSummary } from "./events";
import { RunPaths, nowIso, readJson, writeJsonAtomic } from "./paths";
import { isAlive } from "./watchdog";
import { listTeamTools, processIdentity, reapTeamTools } from "./team-tools";

const RUNTIME_DIR = path.resolve(import.meta.dir, "..");
const sleep = new Int32Array(new SharedArrayBuffer(4));
export type TeamAgentStatus = "starting" | "running" | "idle" | "interrupted";
export interface TeamRecord {
	schema_version: 1;
	task_id: string;
	project_dir: string;
	model: string;
	max_concurrent_agents: number;
	status: "open" | "completed" | "blocked";
	created_at: string;
	finished_at: string | null;
	summary: string | null;
	remaining: string[];
}
export interface TeamAgent {
	schema_version: 1;
	agent_id: string;
	goal_id: string;
	execution_id: string;
	focus: string;
	session_path: string;
	mode: "spawn" | "followup" | "resume";
	resume_commitment_id: string | null;
	status: TeamAgentStatus;
	owner_pid: number;
	runner_pid: number | null;
	pid: number | null;
	runner_started_at: string | null;
	process_started_at: string | null;
	started_at: string;
	finished_at: string | null;
	summary: string | null;
	reasons: RuntimeFailureReason[];
	exit_code: number | null;
}
export interface AgentOutcome {
	status: "idle" | "interrupted";
	reasons?: RuntimeFailureReason[];
	summary: string;
	exit_code: number | null;
}

export function assertTeamId(value: string, kind = "task"): string {
	if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value)) throw new Error(`invalid ${kind} id: ${value}`);
	return value;
}
const teamFile = (paths: RunPaths) => path.join(paths.runDir, "team.json");
const agentFile = (paths: RunPaths, id: string) => path.join(paths.runDir, "agents", assertTeamId(id, "agent"), "agent.json");
const busy = (agent: TeamAgent) => agent.status === "starting" || agent.status === "running";
function validPid(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647;
}
function requirePid(value: unknown): asserts value is number {
	if (!validPid(value)) throw new Error("invalid process identity; refusing to signal or attach");
}

/** A short, shared metadata transaction, never a wait for model work. Crash fails closed. */
function locked<T>(paths: RunPaths, fn: () => T): T {
	assertTeamId(paths.runId);
	if (!fs.existsSync(paths.task)) throw new Error(`unknown task: ${paths.runId}`);
	const file = path.join(paths.runDir, ".team.lock");
	const deadline = Date.now() + 1_000;
	let fd: number;
	for (;;) {
		try { fd = fs.openSync(file, "wx", 0o600); break; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline) throw new Error("Team metadata is locked; if its owner crashed, inspect the lock and stop all executions before recovery. No model work was queued.");
			Atomics.wait(sleep, 0, 0, 5);
		}
	}
	try {
		fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
		return fn();
	} finally { fs.closeSync(fd); fs.unlinkSync(file); }
}
export function loadTeam(paths: RunPaths): TeamRecord {
	assertTeamId(paths.runId);
	const team = readJson<TeamRecord>(teamFile(paths));
	if (team.schema_version !== 1 || team.task_id !== paths.runId || typeof team.project_dir !== "string" || !path.isAbsolute(team.project_dir)
		|| typeof team.model !== "string" || !team.model.includes("/")
		|| !Number.isSafeInteger(team.max_concurrent_agents) || team.max_concurrent_agents < 1
		|| !Array.isArray(team.remaining) || !["open", "completed", "blocked"].includes(team.status)) throw new Error("malformed outer-managed Task");
	return team;
}
export function loadAgent(paths: RunPaths, agentId: string): TeamAgent {
	const agent = readJson<TeamAgent>(agentFile(paths, agentId));
	if (agent.schema_version !== 1 || agent.agent_id !== agentId || !["starting", "running", "idle", "interrupted"].includes(agent.status)
		|| !["spawn", "followup", "resume"].includes(agent.mode)
		|| typeof agent.focus !== "string" || !agent.focus.trim()
		|| !validPid(agent.owner_pid) || (agent.pid !== null && !validPid(agent.pid))
		|| (agent.runner_pid !== null && !validPid(agent.runner_pid))
		|| (agent.runner_started_at !== null && typeof agent.runner_started_at !== "string")
		|| (agent.process_started_at !== null && typeof agent.process_started_at !== "string")
		|| typeof agent.session_path !== "string" || !path.isAbsolute(agent.session_path)) {
		throw new Error(`malformed Agent: ${agentId}`);
	}
	assertTeamId(agent.execution_id, "execution"); assertTeamId(agent.goal_id, "goal");
	const sessionRoot = path.resolve(paths.runDir, "agents", agentId, "sessions");
	const relative = path.relative(sessionRoot, agent.session_path);
	if (relative.startsWith("..") || path.isAbsolute(relative) || path.dirname(relative) !== "." || !relative.endsWith(".jsonl")) throw new Error("Agent session is outside its private session directory");
	if (agent.resume_commitment_id !== null && !/^c_[a-f0-9]{64}$/.test(agent.resume_commitment_id)) throw new Error("invalid resumed Commitment identity");
	return agent;
}
function agents(paths: RunPaths): TeamAgent[] {
	const dir = path.join(paths.runDir, "agents");
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => loadAgent(paths, e.name));
}
function saveAgent(paths: RunPaths, agent: TeamAgent): void {
	writeJsonAtomic(agentFile(paths, agent.agent_id), agent);
	writeJsonAtomic(path.join(paths.executions, agent.execution_id, "agent.json"), agent);
}
function event(paths: RunPaths, kind: string, status: string, payload: Record<string, unknown>): void {
	deliverEvent({ stagingDir: paths.tmp, targetDir: paths.events, counterPath: paths.eventSeq,
		subject: typeof payload.agent_id === "string" ? payload.agent_id : paths.runId,
		kind, status, payload: { task_id: paths.runId, ...payload } });
}
function openTeam(paths: RunPaths): TeamRecord {
	const team = loadTeam(paths);
	if (team.status !== "open") throw new Error(`Task is already ${team.status}: ${paths.runId}`);
	return team;
}
function matching(paths: RunPaths, id: string, execution: string): TeamAgent {
	const agent = loadAgent(paths, id);
	if (agent.execution_id !== execution || !busy(agent)) throw new Error("Agent execution is no longer reserved; startup/control rejected");
	return agent;
}
export function createTeam(paths: RunPaths, objective: string, projectDir: string, model?: string): TeamRecord {
	assertTeamId(paths.runId);
	if (fs.existsSync(paths.runDir)) throw new Error(`Task already exists: ${paths.runId}`);
	const resolved = resolveAgent(path.join(RUNTIME_DIR, "config.json"), model ?? process.env.CODEFLOW_AGENT_MODEL);
	const capacity = Number(process.env.CODEFLOW_MAX_CONCURRENT_AGENTS ?? 8);
	if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("CODEFLOW_MAX_CONCURRENT_AGENTS must be a positive integer");
	createTask(paths, objective);
	const team: TeamRecord = { schema_version: 1, task_id: paths.runId,
		project_dir: fs.realpathSync(projectDir), model: `${resolved.provider}/${resolved.model}`,
		max_concurrent_agents: capacity, status: "open", created_at: nowIso(), finished_at: null, summary: null, remaining: [] };
	writeJsonAtomic(teamFile(paths), team);
	event(paths, "run_started", "STARTED", { summary: objective, orchestration: "outer" });
	return team;
}
export function createTeamGoal(paths: RunPaths, options: CreateGoalOptions) {
	return locked(paths, () => { openTeam(paths); return createGoal(paths, options); });
}
export function teamStatus(paths: RunPaths) {
	const team = loadTeam(paths);
	return { ...team, agents: agents(paths), open_commitments: commitmentHistory(paths)
		.filter(v => !v.folded.terminal).map(v => v.commitment.id) };
}

/** Echo caller-authored instructions, not private Pi context or session contents. */
export function assignmentView(paths: RunPaths, agent: TeamAgent) {
	const goal = goalState(paths, agent.goal_id);
	return {
		schema_version: 1, task_id: paths.runId, agent_id: agent.agent_id,
		execution_id: agent.execution_id, goal_id: agent.goal_id,
		mode: agent.mode, status: agent.status, context_reused: agent.mode === "followup",
		goal: { id: goal.goal_id, objective: goal.objective }, focus: agent.focus,
		resume_commitment_id: agent.resume_commitment_id,
	};
}

/** Reserve capacity and session ownership before fork. Only the outer loop chooses reuse. */
export function launchTeamAgent(paths: RunPaths, input: {
	goalId?: string; focus: string; agentId?: string; mode?: "spawn" | "followup" | "resume";
}, launch = true): TeamAgent {
	if (!input.focus.trim()) throw new Error("an assignment requires a non-empty focus");
	return locked(paths, () => {
		const team = openTeam(paths);
		const mode = input.mode ?? "spawn";
		const previous = input.agentId ? loadAgent(paths, input.agentId) : null;
		if ((mode === "spawn") !== (previous === null)) throw new Error("spawn creates a new Agent; followup/resume require an existing Agent");
		if (previous && busy(previous)) throw new Error(`Agent is busy: ${previous.agent_id}; no assignment was queued`);
		if (previous && (previous.pid !== null || previous.runner_pid !== null)) throw new Error("Agent process shutdown is not reconciled; stop it before reuse");
		if (previous && listTeamTools(paths, previous.execution_id).length) throw new Error("Agent tool cleanup is not reconciled; stop it before reuse");
		if (mode === "followup" && previous?.status !== "idle") throw new Error("followup requires an idle Agent; interrupted work requires explicit resume");
		if (mode === "resume" && previous?.status !== "interrupted") throw new Error("resume requires an interrupted Agent");
		if (mode === "followup" && !fs.existsSync(previous!.session_path)) throw new Error("Agent has no persisted Pi session; spawn a new Agent instead of claiming context reuse");
		const goalId = input.goalId ?? previous?.goal_id ?? paths.runId;
		if (previous && goalId !== previous.goal_id) throw new Error("followup/resume keep the same Goal; spawn for a different outcome boundary");
		const goal = goalState(paths, goalId);
		if (!goal.dependencies.every(id => goalState(paths, id).status === "completed")) throw new Error("Goal dependencies are not completed; nothing was queued");
		if (agents(paths).filter(a => busy(a) || a.pid !== null || a.runner_pid !== null).length >= team.max_concurrent_agents) throw new Error(`Agent concurrency capacity reached (${team.max_concurrent_agents}); nothing was queued`);
		const open = previous ? commitmentHistory(paths).filter(v => !v.folded.terminal && (
			v.commitment.worker_execution_id === previous.execution_id || v.commitment.id === previous.resume_commitment_id)) : [];
		if (mode === "followup" && open.length) throw new Error("Agent has an open Commitment; use explicit resume");
		if (open.length > 1) throw new Error("Agent has multiple open Commitments; inspect before recovery");
		const id = previous?.agent_id ?? `agent-${randomUUID()}`;
		const execution = `exec-${randomUUID()}`;
		const sessionDir = path.join(paths.runDir, "agents", id, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
		const agent: TeamAgent = { schema_version: 1, agent_id: id, goal_id: goalId, execution_id: execution,
			focus: input.focus.trim(), session_path: mode === "followup" ? previous!.session_path : path.join(sessionDir, `${execution}.jsonl`),
			mode, resume_commitment_id: mode === "resume" ? open[0]?.commitment.id ?? null : null,
			status: "starting", owner_pid: process.pid, runner_pid: null, pid: null, runner_started_at: null, process_started_at: null,
			started_at: nowIso(), finished_at: null, summary: null, reasons: [], exit_code: null };
		saveAgent(paths, agent);
		event(paths, "agent_assigned", "STARTING", { agent_id: id, execution_id: execution, goal_id: goalId, mode,
			summary: eventSummary(agent.focus), resume_commitment_id: agent.resume_commitment_id });
		if (!launch) return agent;
		try {
			const child = Bun.spawn([process.execPath, path.join(RUNTIME_DIR, "cli", "team-runner.ts"), path.resolve(paths.code), paths.runId, id, execution], {
				cwd: team.project_dir, env: process.env, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
			});
			agent.runner_pid = child.pid ?? null;
			agent.runner_started_at = processIdentity(child.pid)?.started ?? null;
			saveAgent(paths, agent);
			child.unref();
		} catch (error) {
			agent.status = "interrupted"; agent.finished_at = nowIso(); agent.summary = String(error); agent.reasons = ["WORKER_LAUNCH_FAILURE"];
			saveAgent(paths, agent); throw error;
		}
		return agent;
	});
}

export function beginAgentExecution(paths: RunPaths, agentId: string, executionId: string, runnerPid: number): TeamAgent {
	requirePid(runnerPid);
	return locked(paths, () => {
		openTeam(paths);
		const agent = matching(paths, agentId, executionId);
		if (agent.status !== "starting" || (agent.runner_pid !== null && agent.runner_pid !== runnerPid)) throw new Error("Agent runner already started");
		const identity = processIdentity(runnerPid);
		if (!identity || (agent.runner_started_at !== null && identity.started !== agent.runner_started_at)) throw new Error("Agent runner identity changed");
		agent.runner_pid = runnerPid; agent.runner_started_at = identity.started; agent.status = "running"; saveAgent(paths, agent);
		return agent;
	});
}
export function attachAgentProcess(paths: RunPaths, agentId: string, executionId: string, pid: number): void {
	requirePid(pid);
	locked(paths, () => {
		const agent = matching(paths, agentId, executionId);
		if (agent.pid !== null && agent.pid !== pid) throw new Error("Agent process already attached");
		const identity = processIdentity(pid);
		if (!identity || identity.pgid !== pid) throw new Error("Agent must own a live process group");
		agent.pid = pid; agent.process_started_at = identity.started; saveAgent(paths, agent);
	});
}
/** Called inside Pi, before any provider request. Binds only the reserved execution. */
export function validateTeamAgentStartup(paths: RunPaths, agentId: string, executionId: string, pid = process.pid): { commitment_id: string | null } {
	requirePid(pid);
	return locked(paths, () => {
		openTeam(paths);
		const agent = matching(paths, agentId, executionId);
		if (agent.status !== "running" || agent.runner_pid === null || !isAlive(agent.runner_pid)) throw new Error("Agent runner is not alive");
		if (Number(process.env.CODEFLOW_TEAM_RUNNER_PID) !== agent.runner_pid) throw new Error("Agent runner environment identity mismatch");
		if (processIdentity(agent.runner_pid)?.started !== agent.runner_started_at) throw new Error("Agent runner identity changed");
		if (agent.pid !== null && agent.pid !== pid) throw new Error("Agent process identity mismatch");
		const identity = processIdentity(pid);
		if (!identity || identity.pgid !== pid || (agent.process_started_at !== null && identity.started !== agent.process_started_at)) throw new Error("Agent process identity changed");
		agent.pid = pid; agent.process_started_at = identity.started; saveAgent(paths, agent);
		if (agent.resume_commitment_id) {
			reconcileDeadCommitments(paths, ["TERMINAL_RECEIPT_MISSING"], [agent.resume_commitment_id]);
			resumeCommitment(paths, agent.resume_commitment_id, executionId, pid);
		}
		return { commitment_id: agent.resume_commitment_id };
	});
}
export function completeAgentExecution(paths: RunPaths, agentId: string, executionId: string, outcome: AgentOutcome): void {
	locked(paths, () => {
		const agent = loadAgent(paths, agentId);
		// Late completion can never overwrite a replacement execution or a stop fence.
		if (agent.execution_id !== executionId || !busy(agent)) return;
		Object.assign(agent, outcome, { reasons: outcome.reasons ?? [], pid: null, runner_pid: null, finished_at: nowIso() });
		saveAgent(paths, agent);
		event(paths, "agent_execution_finished", outcome.status.toUpperCase(), { agent_id: agentId, execution_id: executionId,
			goal_id: agent.goal_id, reasons: agent.reasons, summary: eventSummary(outcome.summary), exit_code: outcome.exit_code });
	});
}

/** Explicit recovery/stop: fence first, signal only this Task's published execution groups. */
export async function stopTeamAgents(paths: RunPaths, agentId?: string): Promise<void> {
	const targets = locked(paths, () => {
		openTeam(paths);
		const selected = agentId ? [loadAgent(paths, agentId)] : agents(paths);
		return selected.filter(a => busy(a) || a.pid !== null || a.runner_pid !== null || listTeamTools(paths, a.execution_id).length > 0).map(agent => {
			agent.status = "interrupted"; agent.summary = "Stopped by the outer loop"; agent.reasons = ["USER_CANCELLED"];
			saveAgent(paths, agent); return agent;
		});
	});
	const signal = (pid: number | null, started: string | null, kind: NodeJS.Signals) => {
		if (pid === null || pid === process.pid) return;
		requirePid(pid);
		const current = processIdentity(pid);
		if (!current) return;
		if (!started || current.started !== started || current.pgid !== pid) throw new Error("Agent PID identity changed; refusing to signal a possibly reused process group");
		try { process.kill(-pid, kind); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
	};
	for (const a of targets) { signal(a.pid, a.process_started_at, "SIGTERM"); signal(a.runner_pid, a.runner_started_at, "SIGTERM"); }
	const pids = targets.flatMap(a => [a.pid, a.runner_pid]).filter((p): p is number => p !== null);
	const until = Date.now() + 5_000;
	while (pids.some(isAlive) && Date.now() < until) await Bun.sleep(25);
	for (const a of targets) { signal(a.pid, a.process_started_at, "SIGKILL"); signal(a.runner_pid, a.runner_started_at, "SIGKILL"); }
	const reapUntil = Date.now() + 2_000;
	while (pids.some(isAlive) && Date.now() < reapUntil) await Bun.sleep(25);
	if (pids.some(isAlive)) throw new Error("Agent has not stopped; process identities retained, do not reuse");
	// Pi can be SIGKILLed before its own shutdown hooks. Its shell keepers are
	// separately owned groups, and must be reaped before clearing the Agent.
	for (const target of targets) await reapTeamTools(paths, target.execution_id);
	locked(paths, () => {
		for (const target of targets) {
			const current = loadAgent(paths, target.agent_id);
			if (current.execution_id !== target.execution_id) continue;
			if ([target.pid, target.runner_pid].some(pid => pid !== null && isAlive(pid))) throw new Error("Agent has not stopped; process identities retained, do not reuse");
			current.pid = null; current.runner_pid = null; current.finished_at = nowIso(); saveAgent(paths, current);
			const ids = commitmentHistory(paths).filter(v => v.commitment.worker_execution_id === current.execution_id || v.commitment.id === current.resume_commitment_id).map(v => v.commitment.id);
			reconcileDeadCommitments(paths, ["USER_CANCELLED"], ids);
			event(paths, "agent_execution_finished", "INTERRUPTED", { agent_id: current.agent_id, execution_id: current.execution_id, reasons: current.reasons, summary: current.summary });
		}
	});
}
export function finishTeam(paths: RunPaths, status: "completed" | "blocked", summary: string, remaining: string[] = []): TeamRecord {
	if (!summary.trim() || !["completed", "blocked"].includes(status)) throw new Error("finish requires completed|blocked and a non-empty summary");
	if (status === "completed" && remaining.length) throw new Error("completed cannot contain remaining work");
	if (status === "blocked" && !remaining.some(s => s.trim())) throw new Error("blocked must explain remaining work");
	return locked(paths, () => {
		const team = openTeam(paths);
		if (agents(paths).some(a => busy(a) || a.pid !== null || a.runner_pid !== null || listTeamTools(paths, a.execution_id).length > 0)) throw new Error("Task finish requires every Agent execution to stop");
		const history = commitmentHistory(paths);
		if (history.some(v => !v.folded.terminal)) throw new Error("Task finish requires every open Commitment to be reconciled by its Agent; resume interrupted work first");
		if (status === "completed" && !history.some(v => v.folded.terminal)) throw new Error("Task completion requires a recorded Agent Receipt");
		team.status = status; team.summary = summary.trim(); team.remaining = remaining.map(s => s.trim()); team.finished_at = nowIso();
		writeJsonAtomic(teamFile(paths), team);
		event(paths, "run_finished", status.toUpperCase(), { summary: eventSummary(team.summary), remaining: team.remaining, orchestration: "outer" });
		return team;
	});
}
