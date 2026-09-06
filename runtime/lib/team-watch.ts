/** One read-only, persistent observation stream. Activity extends patience, never model work. */
import * as fs from "node:fs";
import * as path from "node:path";
import { RunPaths, readJson } from "./paths";
import { assignmentView, teamStatus, type TeamAgent } from "./team";
import { loadTask } from "./tasks";
import { loadCommitment } from "./commitment";
import { scan, type ObservedEvent } from "./wait";
import { isAlive } from "./watchdog";
import { processIdentity } from "./team-tools";

export interface ExecutionActivity { agent_id: string; calls: number; last_at: string }

/** Tail complete JSONL rows once; partial writes and unrelated/legacy usage are not heartbeats. */
export class UsageActivityTail {
	private offset = 0;
	private identity = "";
	private pending = Buffer.alloc(0);
	readonly executions = new Map<string, ExecutionActivity>();
	constructor(private paths: RunPaths) {}
	read(): ReadonlyMap<string, ExecutionActivity> {
		let fd: number;
		try { fd = fs.openSync(this.paths.usageLedger, "r"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.executions; throw error; }
		try {
			const stat = fs.fstatSync(fd);
			const identity = `${stat.dev}:${stat.ino}`;
			if (identity !== this.identity || stat.size < this.offset) {
				this.identity = identity; this.offset = 0; this.pending = Buffer.alloc(0); this.executions.clear();
			}
			const buffer = Buffer.alloc(32_768);
			while (this.offset < stat.size) {
				const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - this.offset), this.offset);
				if (!count) break;
				this.offset += count;
				this.pending = Buffer.concat([this.pending, buffer.subarray(0, count)]);
				let end: number;
				while ((end = this.pending.indexOf(10)) >= 0) {
					const line = this.pending.subarray(0, end).toString("utf8");
					this.pending = this.pending.subarray(end + 1);
					if (!line.trim()) continue;
					let row: any;
					try { row = JSON.parse(line); } catch { throw new Error("malformed complete usage ledger row"); }
					if (row?.schema_version !== 1 || row.task_id !== this.paths.runId || row.worker_kind !== "worker") continue;
					if (typeof row.agent_id !== "string" || typeof row.execution_id !== "string"
						|| !/^[a-zA-Z0-9_-]{1,128}$/.test(row.agent_id) || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.execution_id)) continue;
					if (typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at)) || !row.usage
						|| !["input", "output", "cache_read", "cache_write", "reasoning", "total_tokens"].every(key =>
							typeof row.usage[key] === "number" && Number.isFinite(row.usage[key]) && row.usage[key] >= 0)) continue;
					const prior = this.executions.get(row.execution_id);
					if (prior && prior.agent_id !== row.agent_id) throw new Error("inconsistent usage execution attribution");
					this.executions.set(row.execution_id, { agent_id: row.agent_id, calls: (prior?.calls ?? 0) + 1,
						last_at: prior && prior.last_at > row.at ? prior.last_at : row.at });
				}
				if (this.pending.length > 1_048_576) throw new Error("usage ledger row exceeds observation limit");
			}
			return this.executions;
		} finally { fs.closeSync(fd); }
	}
}

interface ActivityState {
	status: string; calls: number; last_at: number; source: "assignment" | "usage" | "status" | "event";
}
export class TeamActivityTracker {
	private states = new Map<string, ActivityState>();
	update(agents: TeamAgent[], usage: ReadonlyMap<string, ExecutionActivity>, now: number, liveEvents = new Set<string>()) {
		return agents.map(agent => {
			const row = usage.get(agent.execution_id);
			const attributed = row?.agent_id === agent.agent_id ? row : undefined;
			const fingerprint = JSON.stringify([agent.status, agent.pid, agent.runner_pid, agent.process_started_at, agent.runner_started_at]);
			let state = this.states.get(agent.execution_id);
			if (!state) {
				const started = Date.parse(agent.started_at);
				const lastUsage = attributed ? Date.parse(attributed.last_at) : -Infinity;
				state = { status: fingerprint, calls: attributed?.calls ?? 0,
					last_at: Math.min(now, Math.max(Number.isFinite(started) ? started : now, lastUsage)),
					source: lastUsage >= started ? "usage" : "assignment" };
			} else {
				if (fingerprint !== state.status) { state.last_at = now; state.source = "status"; }
				if ((attributed?.calls ?? 0) > state.calls) { state.last_at = now; state.source = "usage"; }
				state.status = fingerprint;
				// Truncated/replaced ledgers must not turn replayed old rows into new activity.
				state.calls = Math.max(state.calls, attributed?.calls ?? 0);
			}
			if (liveEvents.has(agent.execution_id)) { state.last_at = now; state.source = "event"; }
			this.states.set(agent.execution_id, state);
			return { agent_id: agent.agent_id, execution_id: agent.execution_id, status: agent.status,
				last_activity_at: new Date(state.last_at).toISOString(), activity_source: state.source,
				usage_available: attributed !== undefined, quiet_ms: Math.max(0, now - state.last_at) };
		});
	}
}

export type ProcessHealth = "alive" | "missing" | "identity_mismatch" | "unknown";
export function probeAgentProcess(agent: TeamAgent): ProcessHealth {
	const identities = [[agent.runner_pid, agent.runner_started_at], [agent.pid, agent.process_started_at]] as const;
	let verified = false;
	for (const [pid, birth] of identities) {
		if (pid === null) continue;
		if (!isAlive(pid)) return "missing";
		if (!birth) continue;
		try {
			const identity = processIdentity(pid);
			if (!identity) return "missing";
			if (identity.started !== birth) return "identity_mismatch";
			verified = true;
		} catch { return "unknown"; }
	}
	if (agent.status === "starting" && agent.runner_pid === null && !isAlive(agent.owner_pid)) return "missing";
	return verified ? "alive" : "unknown";
}

export interface TeamWatchMessage {
	schema_version: 1; task_id: string; seq: number;
	type: "watching" | "assignment" | "event" | "status" | "settled" | "attention" | "finished";
	[key: string]: unknown;
}
export interface TeamWatchOptions {
	since?: number;
	idleMs?: number;
	pollIntervalMs?: number;
	processGraceMs?: number;
	signal?: AbortSignal;
	onMessage: (message: TeamWatchMessage) => void;
	/** Deterministic offline tests; production probes recorded PID birth identities. */
	processProbe?: (agent: TeamAgent) => ProcessHealth;
}

/** Never edits Task state, starts a provider, stops a Worker, or reads a private session. */
export async function watchTeam(paths: RunPaths, options: TeamWatchOptions): Promise<"finished" | "cancelled"> {
	const since = options.since ?? 0;
	const idleMs = options.idleMs ?? 300_000;
	const interval = options.pollIntervalMs ?? 1_000;
	const grace = options.processGraceMs ?? 2_000;
	if (!Number.isSafeInteger(since) || since < 0 || !Number.isSafeInteger(idleMs) || idleMs <= 0
		|| !Number.isSafeInteger(interval) || interval <= 0 || !Number.isSafeInteger(grace) || grace < 0) throw new Error("invalid watch interval or cursor");
	const tail = new UsageActivityTail(paths);
	const tracker = new TeamActivityTracker();
	const seen = new Set<string>();
	const watchers = new Map<string, fs.FSWatcher>();
	const warned = new Map<string, string>();
	const missingSince = new Map<string, number>();
	const probes = new Map<string, { at: number; status: string; health: ProcessHealth }>();
	let seq = since;
	let first = true;
	let previousStatus = "";
	let settled = false;
	let notified = false;
	let wakeup: (() => void) | undefined;
	const wake = () => { notified = true; wakeup?.(); };
	const timer = setInterval(wake, interval);
	options.signal?.addEventListener("abort", wake);
	const emit = (type: TeamWatchMessage["type"], fields: Record<string, unknown>) => options.onMessage({ schema_version: 1, task_id: paths.runId, seq, type, ...fields });
	const observe = (directory: string, names?: string[]) => {
		if (watchers.has(directory)) return;
		try {
			const watcher = fs.watch(directory, (_kind, name) => { if (!names || name === null || names.includes(String(name))) wake(); });
			watcher.on("error", () => { watcher.close(); watchers.delete(directory); wake(); });
			watchers.set(directory, watcher);
		} catch { /* The persistent timer covers absent directories and lossy filesystem watches. */ }
	};
	try {
		for (;;) {
			if (options.signal?.aborted) return "cancelled";
			const state = teamStatus(paths);
			observe(paths.runDir, ["team.json", "usage.jsonl", "agents", "events"]);
			observe(paths.events);
			observe(path.join(paths.runDir, "agents"));
			for (const agent of state.agents) observe(path.join(paths.runDir, "agents", agent.agent_id), ["agent.json"]);
			// Keep the original cursor and a seen set: a delayed lower-sequence rename
			// must not disappear behind a concurrent writer's higher sequence.
			const read = scan(paths.events, since, [], seen);
			const events = read.events;
			for (const event of events) seen.add(event.file);
			const owner = (event: ObservedEvent): TeamAgent | undefined => {
				if (event.execution_id) return state.agents.find(a => a.execution_id === event.execution_id);
				if (event.agent_id) return state.agents.find(a => a.agent_id === event.agent_id);
				if (event.commitment_id) {
					const commitment = loadCommitment(paths, event.commitment_id);
					return state.agents.find(a => a.resume_commitment_id === commitment.id || a.execution_id === commitment.worker_execution_id);
				}
			};
			const owners = new Map(events.map(event => [event.seq, owner(event)]));
			const liveEvents = new Set(first ? [] : [...owners.values()].flatMap(a => a ? [a.execution_id] : []));
			const now = Date.now();
			const activity = tracker.update(state.agents, tail.read(), now, liveEvents);
			const agents = state.agents.map(a => ({ agent_id: a.agent_id, execution_id: a.execution_id, goal_id: a.goal_id,
				status: a.status, mode: a.mode, reasons: a.reasons }));
			const status = JSON.stringify([state.status, agents, state.open_commitments]);
			if (first) emit("watching", { goal: loadTask(paths).objective, status: state.status, agents, idle_seconds: idleMs / 1000 });
			for (const event of events) {
				// Do not acknowledge a whole batch in its first streamed line. A host
				// may disconnect between lines and reconnect using the last delivered seq.
				seq = Math.max(seq, event.seq);
				if (event.kind === "agent_assigned" && event.execution_id && event.agent_id) {
					const agent = readJson<TeamAgent>(path.join(paths.executions, event.execution_id, "agent.json"));
					if (agent.execution_id !== event.execution_id || agent.agent_id !== event.agent_id) throw new Error("assignment event identity mismatch");
					emit("assignment", { event_seq: event.seq, assignment: assignmentView(paths, agent) });
				} else emit("event", { event: { ...event, ...(owners.get(event.seq) ? { agent_id: owners.get(event.seq)!.agent_id } : {}) } });
			}
			if (!first && status !== previousStatus) emit("status", { status: state.status, agents, open_commitments: state.open_commitments });
			previousStatus = status; first = false;
			if (state.status !== "open") {
				emit("finished", { status: state.status, summary: state.summary, remaining: state.remaining });
				return "finished";
			}
			for (const agent of state.agents) {
				const current = activity.find(a => a.execution_id === agent.execution_id)!;
				const active = agent.status === "starting" || agent.status === "running";
				let reason: string | undefined;
				let health: ProcessHealth = "unknown";
				if (agent.status === "interrupted") reason = "execution_interrupted";
				if (active) {
					const fingerprint = JSON.stringify([agent.status, agent.pid, agent.runner_pid, agent.process_started_at, agent.runner_started_at]);
					let probe = probes.get(agent.execution_id);
					if (!probe || now - probe.at >= 5_000 || probe.status !== fingerprint) {
						probe = { at: now, status: fingerprint, health: (options.processProbe ?? probeAgentProcess)(agent) };
						probes.set(agent.execution_id, probe);
					}
					health = probe.health;
					if (health === "missing" || health === "identity_mismatch") {
						if (!missingSince.has(agent.execution_id)) missingSince.set(agent.execution_id, now);
						if (now - missingSince.get(agent.execution_id)! >= grace) reason = `process_${health}`;
					} else missingSince.delete(agent.execution_id);
					if (!reason && current.quiet_ms >= idleMs) reason = "inactive";
				}
				const key = reason === "inactive" ? `${reason}:${current.last_activity_at}` : reason;
				if (key && warned.get(agent.execution_id) !== key) {
					emit("attention", { agent_id: agent.agent_id, execution_id: agent.execution_id, reason, process_health: health,
						activity: current, summary: reason === "inactive"
							? "No new attributed usage or status within the observation window; inspect pending provider/tool work. This does not prove the Worker is dead."
							: "Execution needs inspection; the observer has not stopped, resumed, or changed it." });
					warned.set(agent.execution_id, key);
				} else if (!key) warned.delete(agent.execution_id);
			}
			const quiet = state.agents.every(a => (a.status === "idle" || a.status === "interrupted") && a.pid === null && a.runner_pid === null);
			if (quiet && !settled) emit("settled", { status: state.status, agents, open_commitments: state.open_commitments,
				summary: "No active Agent execution. Task remains open; keep this stream for followups or explicit finish." });
			settled = quiet;
			// Usage-only notifications update the per-execution deadline silently.
			if (!notified) await new Promise<void>(resolve => { wakeup = resolve; });
			wakeup = undefined; notified = false;
		}
	} finally {
		clearInterval(timer); options.signal?.removeEventListener("abort", wake);
		for (const watcher of watchers.values()) watcher.close();
	}
}
