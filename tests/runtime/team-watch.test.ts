import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunPaths, writeJsonAtomic } from "../../runtime/lib/paths";
import { assignmentView, beginAgentExecution, completeAgentExecution, createTeam, finishTeam, launchTeamAgent, loadAgent, teamStatus } from "../../runtime/lib/team";
import { appendUsageRecord, usageRecordFromMessage, type UsageRecord } from "../../runtime/lib/usage";
import { TeamActivityTracker, UsageActivityTail, WATCH_EXIT, WatchJournal, watchTeam,
	type ProcessHealth, type TeamWatchMessage, type TeamWatchOptions } from "../../runtime/lib/team-watch";
import { claimTestWork } from "./helpers";
import { submitReceipt } from "../../runtime/lib/commitment";
import { scan } from "../../runtime/lib/wait";

const root = path.resolve(import.meta.dir, "../..");
const dirs: string[] = [];
const monitors: Array<{ cancel: AbortController; done: Promise<unknown> }> = [];
const saved = { ...process.env };
afterEach(async () => {
	for (const m of monitors) m.cancel.abort();
	await Promise.all(monitors.splice(0).map(m => m.done));
	for (const key of Object.keys(process.env)) if (key.startsWith("CODEFLOW_")) delete process.env[key];
	for (const [key, value] of Object.entries(saved)) if (key.startsWith("CODEFLOW_") && value !== undefined) process.env[key] = value;
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	for (const key of Object.keys(process.env)) if (key.startsWith("CODEFLOW_")) delete process.env[key];
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-watch-")); dirs.push(dir);
	const paths = new RunPaths(path.join(dir, "runs"), "task-watch");
	createTeam(paths, "Verify observable work\nwithout a hidden Manager", dir, "offline/agent");
	return { dir, paths };
}
function record(paths: RunPaths, agent: ReturnType<typeof launchTeamAgent>, overrides: Partial<UsageRecord> = {}): UsageRecord {
	return { schema_version: 1, at: new Date().toISOString(), task_id: paths.runId, worker_kind: "worker",
		agent_id: agent.agent_id, execution_id: agent.execution_id, goal_id: agent.goal_id, commitment_id: null,
		turn: 1, provider: "offline", model: "agent", response_model: "agent",
		usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, reasoning: 0, total_tokens: 2,
			cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 } }, ...overrides };
}
function monitor(paths: RunPaths, idleMs = 10_000, since = 0, extra: Partial<TeamWatchOptions> = {}) {
	const cancel = new AbortController(); const messages: TeamWatchMessage[] = []; let ended = false;
	const done = watchTeam(paths, { since, idleMs, pollIntervalMs: 10, signal: cancel.signal,
		processProbe: () => "alive", onMessage: m => messages.push(m), ...extra }).finally(() => { ended = true; });
	monitors.push({ cancel, done }); return { cancel, done, messages, ended: () => ended };
}
async function until(condition: () => boolean, timeout = 2_000) {
	const end = Date.now() + timeout;
	while (!condition()) { if (Date.now() > end) throw new Error("watch condition timed out"); await Bun.sleep(10); }
}
function finishAssignment(paths: RunPaths, agent: ReturnType<typeof launchTeamAgent>) {
	const c = claimTestWork(paths, { goalId: agent.goal_id, workerExecutionId: agent.execution_id, work: agent.focus });
	submitReceipt(paths, { commitmentId: c.id, status: "completed", summary: "Verified fixture" });
	completeAgentExecution(paths, agent.agent_id, agent.execution_id, { status: "idle", summary: "Verified fixture", exit_code: 0 });
}

describe("attributed, incremental usage activity", () => {
	test("new usage identifies the Agent/execution even before its Claim", () => {
		const { paths } = fixture(); const agent = launchTeamAgent(paths, { focus: "Inspect before claiming" }, false);
		process.env.CODEFLOW_RUN_ID = paths.runId; process.env.CODEFLOW_GOAL_ID = paths.runId;
		process.env.CODEFLOW_TEAM_AGENT_ID = agent.agent_id; process.env.CODEFLOW_EXECUTION_ID = agent.execution_id;
		const usage = usageRecordFromMessage({ role: "assistant", provider: "offline", model: "agent",
			usage: { input: 3, output: 2, totalTokens: 5 } }, 1)!;
		expect(usage).toMatchObject({ agent_id: agent.agent_id, execution_id: agent.execution_id, commitment_id: null });
		appendUsageRecord(paths, usage);
		expect(new UsageActivityTail(paths).read().get(agent.execution_id)?.calls).toBe(1);
	});
	test("partial rows, service calls, old ledgers, and peers are not guessed into a heartbeat", () => {
		const { paths } = fixture(); const a = launchTeamAgent(paths, { focus: "A" }, false);
		const b = launchTeamAgent(paths, { focus: "B" }, false);
		appendUsageRecord(paths, record(paths, a, { agent_id: undefined, execution_id: undefined }));
		appendUsageRecord(paths, record(paths, a, { worker_kind: "service" }));
		appendUsageRecord(paths, record(paths, a, { task_id: "some-other-task" }));
		const reader = new UsageActivityTail(paths);
		expect(reader.read().size).toBe(0);
		const bytes = JSON.stringify(record(paths, b));
		fs.appendFileSync(paths.usageLedger, bytes.slice(0, 30));
		expect(reader.read().size).toBe(0);
		fs.appendFileSync(paths.usageLedger, bytes.slice(30) + "\n");
		expect(reader.read().get(b.execution_id)?.calls).toBe(1);
		expect(reader.read().has(a.execution_id)).toBe(false);
		for (let i = 0; i < 3; i++) expect(reader.read().get(b.execution_id)?.calls).toBe(1);
		fs.writeFileSync(paths.usageLedger, "");
		expect(reader.read().size).toBe(0);
		appendUsageRecord(paths, record(paths, a));
		expect(reader.read().get(a.execution_id)?.calls).toBe(1);
	});
	test("malformed complete rows are an observation error, not fresh usage", () => {
		const { paths } = fixture(); const reader = new UsageActivityTail(paths);
		fs.writeFileSync(paths.usageLedger, "{partial"); expect(reader.read().size).toBe(0);
		fs.appendFileSync(paths.usageLedger, "\n"); expect(() => reader.read()).toThrow(/malformed complete usage/);
	});
	test("usage and status extend only the matching execution, not unchanged samples or old sessions", () => {
		const { paths } = fixture(); const a = launchTeamAgent(paths, { focus: "A" }, false);
		const b = launchTeamAgent(paths, { focus: "B" }, false);
		a.started_at = b.started_at = new Date(0).toISOString();
		const tracker = new TeamActivityTracker(); const activity = new Map();
		tracker.update([a, b], activity, 0);
		activity.set(a.execution_id, { agent_id: a.agent_id, calls: 1, last_at: new Date(80).toISOString() });
		const next = tracker.update([a, b], activity, 80);
		expect(next.map(v => v.quiet_ms)).toEqual([0, 80]);
		expect(tracker.update([a, b], activity, 150).map(v => v.quiet_ms)).toEqual([70, 150]);
		a.status = "running";
		expect(tracker.update([a, b], activity, 180).map(v => v.quiet_ms)).toEqual([0, 180]);
		const reused = { ...a, execution_id: "exec-new-session-round", started_at: new Date(190).toISOString() };
		expect(tracker.update([reused], activity, 200)[0]).toMatchObject({ usage_available: false, quiet_ms: 10 });
		activity.get(a.execution_id).calls++;
		expect(tracker.update([reused], activity, 250)[0].quiet_ms).toBe(60);
	});
});

describe("one persistent Task observation context", () => {
	test("keeps the same watcher through progress, idle, followup, and explicit Task finish", async () => {
		const { paths } = fixture();
		const a = launchTeamAgent(paths, { focus: "First exact focus\nwith a write boundary" }, false);
		// Invalid JSON is deliberate: the observer must never parse this private file.
		fs.writeFileSync(a.session_path, "PRIVATE_SESSION_SENTINEL");
		const m = monitor(paths);
		const c = claimTestWork(paths, { goalId: paths.runId, workerExecutionId: a.execution_id, work: "Inspect the boundary" });
		submitReceipt(paths, { commitmentId: c.id, status: "progress", summary: "Reproduction established", remaining: ["Implement and verify"] });
		await until(() => m.messages.some((x: any) => x.event?.status === "PROGRESS"));
		expect(teamStatus(paths).open_commitments).toEqual([c.id]);
		submitReceipt(paths, { commitmentId: c.id, status: "completed", summary: "First result verified" });
		completeAgentExecution(paths, a.agent_id, a.execution_id, { status: "idle", summary: "First done", exit_code: 0 });
		await until(() => m.messages.some(x => x.type === "settled"));
		expect(m.ended()).toBe(false);
		const b = launchTeamAgent(paths, { agentId: a.agent_id, mode: "followup", focus: "Check the new counterexample" }, false);
		await until(() => m.messages.filter(x => x.type === "assignment").length === 2);
		const prompts = m.messages.filter(x => x.type === "assignment").map((x: any) => x.assignment);
		expect(prompts.map(x => x.focus)).toEqual([a.focus, b.focus]);
		expect(prompts.map(x => x.context_reused)).toEqual([false, true]);
		expect(prompts.every(x => x.goal.objective === "Verify observable work\nwithout a hidden Manager")).toBe(true);
		expect(JSON.stringify(m.messages)).not.toContain("PRIVATE_SESSION_SENTINEL");
		expect(JSON.stringify(m.messages)).not.toContain("session_path");
		finishAssignment(paths, b); finishTeam(paths, "completed", "Independent result checked");
		expect(await m.done).toBe("finished");
		expect(m.messages.at(-1)).toMatchObject({ type: "finished", status: "completed" });
		expect(m.messages.filter(x => x.type === "watching")).toHaveLength(1);
	});
	test("usage silently renews patience while a quiet peer gets one non-destructive attention notice", async () => {
		const { paths } = fixture(); const a = launchTeamAgent(paths, { focus: "Active" }, false);
		const b = launchTeamAgent(paths, { focus: "Quiet" }, false); const m = monitor(paths, 300);
		const initial = m.messages.length;
		for (let i = 0; i < 7; i++) { await Bun.sleep(70); appendUsageRecord(paths, record(paths, a)); }
		await until(() => m.messages.some(x => x.type === "attention"));
		const attention = m.messages.filter(x => x.type === "attention");
		expect(attention).toHaveLength(1);
		expect(attention[0]).toMatchObject({ agent_id: b.agent_id, reason: "inactive", process_health: "alive" });
		expect(m.messages.slice(initial).every(x => x.type === "attention")).toBe(true);
		expect(m.ended()).toBe(false);
		expect(loadAgent(paths, b.agent_id).status).toBe("starting");
		m.cancel.abort(); expect(await m.done).toBe("cancelled");
		expect(teamStatus(paths).status).toBe("open");
		expect(teamStatus(paths).agents.every(x => x.status === "starting")).toBe(true);
	});
	test("status transitions renew the window and cancellation leaves an open Commitment untouched", async () => {
		const { paths } = fixture(); const a = launchTeamAgent(paths, { focus: "Long tool" }, false);
		const c = claimTestWork(paths, { goalId: paths.runId, workerExecutionId: a.execution_id, work: a.focus });
		const m = monitor(paths, 300); await Bun.sleep(200);
		beginAgentExecution(paths, a.agent_id, a.execution_id, process.pid);
		await until(() => m.messages.some(x => x.type === "status"));
		await Bun.sleep(160);
		expect(m.messages.filter(x => x.type === "attention")).toHaveLength(0);
		m.cancel.abort(); await m.done;
		expect(teamStatus(paths).open_commitments).toEqual([c.id]);
		expect(loadAgent(paths, a.agent_id).runner_pid).toBe(process.pid);
	});
	test("a missing process reports attention without inventing a terminal Receipt", async () => {
		const { paths } = fixture(); const a = launchTeamAgent(paths, { focus: "Lost runner" }, false);
		writeJsonAtomic(path.join(paths.runDir, "agents", a.agent_id, "agent.json"), { ...a, owner_pid: 2_000_000_000 });
		const cancel = new AbortController(); const messages: TeamWatchMessage[] = [];
		const done = watchTeam(paths, { signal: cancel.signal, pollIntervalMs: 10, processGraceMs: 0, onMessage: x => messages.push(x) });
		monitors.push({ cancel, done });
		await until(() => messages.some(x => x.type === "attention"));
		expect(messages.find(x => x.type === "attention")).toMatchObject({ reason: "process_missing" });
		expect(loadAgent(paths, a.agent_id).status).toBe("starting");
		expect(scan(paths.events, 0, ["receipt_submitted", "agent_execution_finished"]).events).toEqual([]);
	});
		test("already finished Tasks return once and since suppresses old events", async () => {
		const { paths } = fixture(); const a = launchTeamAgent(paths, { focus: "Done" }, false);
		finishAssignment(paths, a); finishTeam(paths, "completed", "Done");
		const cursor = scan(paths.events, 0, []).waterMark;
		const replay = monitor(paths);
		expect(await replay.done).toBe("finished");
		expect(replay.messages[0].seq).toBe(0);
		for (const message of replay.messages as any[]) {
			if (message.type === "event") expect(message.seq).toBe(message.event.seq);
			if (message.type === "assignment") expect(message.seq).toBe(message.event_seq);
		}
		const m = monitor(paths, 300, cursor);
		expect(await m.done).toBe("finished");
		expect(m.messages.map(x => x.type)).toEqual(["watching", "finished"]);
	});
	test("late lower-sequence delivery is not lost within the persistent stream", async () => {
		const { paths } = fixture(); launchTeamAgent(paths, { focus: "In progress" }, false);
		const cursor = scan(paths.events, 0, []).waterMark;
		const m = monitor(paths, 3000, cursor);
		const write = (seq: number) => fs.writeFileSync(path.join(paths.events, `${String(seq).padStart(5, "0")}--task-watch--goal_updated--UPDATED.json`), "{}");
		write(cursor + 2); await until(() => m.messages.some((x: any) => x.event?.seq === cursor + 2));
		write(cursor + 1); await until(() => m.messages.some((x: any) => x.event?.seq === cursor + 1));
		expect(m.messages.filter(x => x.type === "event")).toHaveLength(2);
	});
	test("assignment output exposes exact instructions and reuse, not internal process/session paths", () => {
		const { paths } = fixture(); const a = launchTeamAgent(paths, { focus: "  Exact first line\nSecond line  " }, false);
		const view = assignmentView(paths, a);
		expect(view).toMatchObject({ focus: "Exact first line\nSecond line", context_reused: false, goal: { id: paths.runId } });
		expect(view).not.toHaveProperty("session_path"); expect(view).not.toHaveProperty("owner_pid");
	});
	test("CLI start echoes the Goal and watch rejects bad input without sourcing credentials", () => {
		const { dir, paths } = fixture(); const config = path.join(dir, "config"); fs.mkdirSync(config);
		fs.writeFileSync(path.join(config, ".env"), "echo SHOULD_NOT_BE_SOURCED >&2\nexit 77\n");
		const run = (args: string[]) => Bun.spawnSync(["bash", path.join(root, "runtime/bin/codeteam"), ...args], {
			cwd: dir, env: { ...process.env, CODEFLOW_HOME: config, CODEFLOW_RUNS_DIR: paths.code }, stdout: "pipe", stderr: "pipe" });
		const started = run(["start", "--model", "offline/agent", "Visible initial goal"]);
		expect(started.exitCode).toBe(0); expect(JSON.parse(started.stdout.toString()).goal.objective).toBe("Visible initial goal");
		for (const args of [["--idle", "0"], ["--since", "-1"], ["--idle", "NaN"], ["--timeout", "1"]]) {
			const result = run(["watch", paths.runId, ...args]); expect(result.exitCode).toBe(1);
			expect(result.stderr.toString()).not.toContain("SHOULD_NOT_BE_SOURCED");
		}
	});
});

describe("context pressure projection through the persistent stream", () => {
	const measurement = { basis: "pi_estimate", utilization: 0.86, threshold: 0.8, tokens: 172_000, context_window: 200_000 };
	function writePressure(paths: RunPaths, agent: ReturnType<typeof launchTeamAgent>, seq: number,
		pressure: unknown = measurement, extra: Record<string, unknown> = {}) {
		fs.writeFileSync(path.join(paths.events, `${String(seq).padStart(5, "0")}--${agent.agent_id}--context_pressure--UPDATED.json`),
			JSON.stringify({ task_id: paths.runId, goal_id: agent.goal_id, agent_id: agent.agent_id,
				execution_id: agent.execution_id, context_pressure: pressure, ...extra }) + "\n");
	}

	test("streams the whitelist projection once, attributed to the owning execution, with no session leakage", async () => {
		const { paths } = fixture();
		const a = launchTeamAgent(paths, { focus: "Pressured" }, false);
		const b = launchTeamAgent(paths, { focus: "Peer" }, false);
		const m = monitor(paths);
		const cursor = scan(paths.events, 0, []).waterMark;
		writePressure(paths, a, cursor + 1, { ...measurement, model_prose: "private model prose", session_path: "/private/a/session.jsonl" },
			{ session: "PRIVATE_SESSION_SENTINEL" });
		await until(() => m.messages.some((x: any) => x.type === "event" && x.event?.kind === "context_pressure"));
		const message = m.messages.find((x: any) => x.type === "event" && x.event?.kind === "context_pressure")!;
		expect(message).toMatchObject({ schema_version: 1, task_id: paths.runId, type: "event" });
		expect(message.event).toMatchObject({ kind: "context_pressure", status: "UPDATED", seq: cursor + 1,
			agent_id: a.agent_id, execution_id: a.execution_id, goal_id: a.goal_id, context_pressure: measurement });
		expect(JSON.stringify(message.event)).not.toContain("private model prose");
		expect(JSON.stringify(m.messages)).not.toContain("PRIVATE_SESSION_SENTINEL");
		expect(m.messages.some((x: any) => x.type === "event" && x.event?.kind === "context_pressure" && x.event?.agent_id === b.agent_id)).toBe(false);
		// Silent usage renewals cycle the loop; the seen set must not re-emit the same event.
		for (let i = 0; i < 3; i++) { await Bun.sleep(40); appendUsageRecord(paths, record(paths, a)); }
		await Bun.sleep(120);
		expect(m.messages.filter((x: any) => x.type === "event" && x.event?.seq === cursor + 1)).toHaveLength(1);
		m.cancel.abort(); expect(await m.done).toBe("cancelled");
	});

	test("reconnecting with since replays nothing and attributes a later signal to its own execution", async () => {
		const { paths } = fixture();
		const a = launchTeamAgent(paths, { focus: "First" }, false);
		const b = launchTeamAgent(paths, { focus: "Second" }, false);
		let cursor = scan(paths.events, 0, []).waterMark;
		writePressure(paths, a, cursor + 1);
		const first = monitor(paths, 10_000, cursor);
		await until(() => first.messages.some((x: any) => x.type === "event" && x.event?.kind === "context_pressure"));
		first.cancel.abort(); await first.done;
		cursor = scan(paths.events, 0, []).waterMark;
		const second = monitor(paths, 10_000, cursor);
		await Bun.sleep(150);
		expect(second.messages.some((x: any) => x.type === "event" && x.event?.seq <= cursor)).toBe(false);
		writePressure(paths, b, cursor + 1, { ...measurement, utilization: 0.55, threshold: 0.5, tokens: 110_000 });
		await until(() => second.messages.some((x: any) => x.type === "event" && x.event?.kind === "context_pressure"));
		const event = (second.messages.find((x: any) => x.type === "event" && x.event?.kind === "context_pressure")!).event as any;
		expect(event.agent_id).toBe(b.agent_id);
		expect(event.execution_id).toBe(b.execution_id);
		expect(event.context_pressure).toEqual({ ...measurement, utilization: 0.55, threshold: 0.5, tokens: 110_000 });
		second.cancel.abort(); await second.done;
	});
});

describe("silent background observation", () => {
	test("a Runtime failure that appears while watching ends the loop for its host", async () => {
		const { paths } = fixture(); const a = launchTeamAgent(paths, { focus: "Dies mid-flight" }, false);
		let health: ProcessHealth = "alive";
		const m = monitor(paths, 10_000, 0, { wakeOnFailure: true, processGraceMs: 0, processProbe: () => health });
		await until(() => m.messages.some(x => x.type === "watching"));
		health = "missing";
		// A status change re-probes immediately; a live Worker is only re-checked periodically.
		beginAgentExecution(paths, a.agent_id, a.execution_id, process.pid);
		expect(await m.done).toBe("aborted");
		expect(m.messages.at(-1)).toMatchObject({ type: "attention", reason: "process_missing" });
		// Leaving is observation only: no invented Receipt, no state edit.
		expect(loadAgent(paths, a.agent_id).status).toBe("running");
		expect(teamStatus(paths).status).toBe("open");
		expect(scan(paths.events, 0, ["receipt_submitted", "agent_execution_finished"]).events).toEqual([]);
	});
	test("a failure that predates the watch notifies without exiting a restarted observer", async () => {
		const { paths } = fixture(); launchTeamAgent(paths, { focus: "Already dead" }, false);
		const m = monitor(paths, 10_000, 0, { wakeOnFailure: true, processGraceMs: 0, processProbe: () => "missing" });
		await until(() => m.messages.some(x => x.type === "attention"));
		await Bun.sleep(60);
		expect(m.messages.filter(x => x.type === "attention")).toHaveLength(1);
		expect(m.ended()).toBe(false);
		m.cancel.abort(); expect(await m.done).toBe("cancelled");
	});
	test("inactivity keeps a quiet watch waiting unless the caller asked to be woken", async () => {
		const patient = fixture(); launchTeamAgent(patient.paths, { focus: "Long provider request" }, false);
		const quiet = monitor(patient.paths, 50, 0, { wakeOnFailure: true });
		await until(() => quiet.messages.some(x => x.type === "attention"));
		await Bun.sleep(60);
		expect(quiet.messages.filter(x => x.type === "attention")).toHaveLength(1);
		expect(quiet.ended()).toBe(false);
		// A restarted observer inherits the same silence and still keeps waiting.
		const restarted = monitor(patient.paths, 50, 0, { wakeOnFailure: true, wakeOnIdle: true });
		await until(() => restarted.messages.some(x => x.type === "attention"));
		await Bun.sleep(60); expect(restarted.ended()).toBe(false);
		quiet.cancel.abort(); restarted.cancel.abort();
		const { paths } = fixture(); launchTeamAgent(paths, { focus: "Goes quiet after assignment" }, false);
		const waking = monitor(paths, 50, 0, { wakeOnFailure: true, wakeOnIdle: true });
		expect(await waking.done).toBe("aborted");
		expect(waking.messages.at(-1)).toMatchObject({ type: "attention", reason: "inactive" });
	});
	test("an open Task with nothing executing hands control back to the outer loop", async () => {
		const { paths } = fixture(); const a = launchTeamAgent(paths, { focus: "One assignment" }, false);
		const running = monitor(paths, 10_000, 0, { wakeOnFailure: true, wakeOnSettled: true });
		await until(() => running.messages.some(x => x.type === "watching"));
		await Bun.sleep(60);
		// A reserved or running execution is not settled work.
		expect(running.ended()).toBe(false);
		finishAssignment(paths, a);
		expect(await running.done).toBe("settled");
		expect(running.messages.at(-1)).toMatchObject({ type: "settled" });
		expect(teamStatus(paths).status).toBe("open");
		// Already settled when the watch starts is the answer too, not a missed signal.
		const restarted = monitor(paths, 10_000, 0, { wakeOnFailure: true, wakeOnSettled: true });
		expect(await restarted.done).toBe("settled");
		// Without the option the same Task keeps one patient observer.
		const patient = monitor(paths, 10_000, 0, { wakeOnFailure: true });
		await until(() => patient.messages.some(x => x.type === "settled"));
		await Bun.sleep(60); expect(patient.ended()).toBe(false);
		patient.cancel.abort(); expect(await patient.done).toBe("cancelled");
	});
	test("a Task that has never assigned work is not settled work", async () => {
		const { paths } = fixture();
		const m = monitor(paths, 10_000, 0, { wakeOnFailure: true, wakeOnSettled: true });
		await until(() => m.messages.some(x => x.type === "watching"));
		await Bun.sleep(80);
		expect(m.ended()).toBe(false);
		m.cancel.abort(); expect(await m.done).toBe("cancelled");
	});
	test("the journal keeps every observation and stdout keeps only the terminal result", () => {
		const { dir, paths } = fixture();
		const log = path.join(dir, "nested", "watch.ndjson");
		const journal = new WatchJournal(paths, log);
		const message = (type: TeamWatchMessage["type"], fields: Record<string, unknown> = {}, seq = 0): TeamWatchMessage =>
			({ schema_version: 1, task_id: paths.runId, seq, type, ...fields });
		journal.record(message("watching", { agents: [{ agent_id: "agent-1" }] }));
		journal.record(message("attention", { execution_id: "exec-1", reason: "inactive" }, 3));
		journal.record(message("attention", { execution_id: "exec-1", reason: "inactive" }, 4));
		journal.record(message("attention", { execution_id: "exec-1", reason: "process_missing" }, 5));
		journal.record(message("finished", { status: "blocked", summary: "Provider unavailable", remaining: ["Retry"] }, 5));
		journal.close();
		const rows = fs.readFileSync(log, "utf-8").trim().split("\n").map(line => JSON.parse(line));
		expect(rows).toHaveLength(5);
		const blocked = journal.result("finished");
		expect(blocked).toMatchObject({ type: "watch_result", outcome: "finished", status: "blocked",
			summary: "Provider unavailable", remaining: ["Retry"], last_seq: 5, log, exit_code: WATCH_EXIT.blocked });
		// One entry per execution and reason: the journal, not the closing line, is the history.
		expect(blocked.attention.map(x => x.reason)).toEqual(["inactive", "process_missing"]);
		expect(blocked.agents).toEqual([{ agent_id: "agent-1" }]);
		expect(journal.result("cancelled").exit_code).toBe(WATCH_EXIT.completed);
		// An open Task has no status of its own; leaving one is a Runtime interruption.
		const interrupted = new WatchJournal(paths, null);
		interrupted.record(message("attention", { execution_id: "exec-1", reason: "process_missing" }, 2));
		expect(interrupted.result("aborted")).toMatchObject({ status: null, remaining: [], last_seq: 2,
			log: null, exit_code: WATCH_EXIT.runtime });
		expect(new WatchJournal(paths, null).result("finished")).toMatchObject({ last_seq: 0, exit_code: WATCH_EXIT.failed });
		expect(new WatchJournal(paths, null).result("settled")).toMatchObject({ status: null, exit_code: WATCH_EXIT.settled });
	});
	test("the quiet CLI prints one line, journals the stream, and reports the Task in its exit code", () => {
		const { dir, paths } = fixture(); const a = launchTeamAgent(paths, { focus: "Quiet run" }, false);
		finishAssignment(paths, a);
		const run = (args: string[]) => Bun.spawnSync(["bash", path.join(root, "runtime/bin/codeteam"), ...args], {
			cwd: dir, env: { ...process.env, CODEFLOW_RUNS_DIR: paths.code }, stdout: "pipe", stderr: "pipe" });
		finishTeam(paths, "completed", "Quiet result verified");
		const completed = run(["watch", paths.runId, "--quiet"]);
		expect(completed.exitCode).toBe(WATCH_EXIT.completed);
		const lines = completed.stdout.toString().trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toMatchObject({ type: "watch_result", outcome: "finished", status: "completed",
			summary: "Quiet result verified", log: path.join(paths.runDir, "watch.ndjson") });
		const journalled = fs.readFileSync(path.join(paths.runDir, "watch.ndjson"), "utf-8").trim().split("\n").map(l => JSON.parse(l));
		expect(journalled.map(x => x.type)).toContain("watching");
		expect(journalled.at(-1)).toMatchObject({ type: "finished", status: "completed" });
		const streamed = run(["watch", paths.runId]);
		expect(streamed.exitCode).toBe(WATCH_EXIT.completed);
		const types = streamed.stdout.toString().trim().split("\n").map(l => JSON.parse(l).type);
		expect(types[0]).toBe("watching");
		// The terminal result is additive: a streaming reader keeps every message it had.
		expect(types.slice(-2)).toEqual(["finished", "watch_result"]);
	});
	test("the quiet CLI reports a settled open Task with its own exit code", () => {
		const { dir, paths } = fixture(); const a = launchTeamAgent(paths, { focus: "Settled run" }, false);
		finishAssignment(paths, a);
		const result = Bun.spawnSync(["bash", path.join(root, "runtime/bin/codeteam"), "watch", paths.runId, "--quiet"], {
			cwd: dir, env: { ...process.env, CODEFLOW_RUNS_DIR: paths.code }, stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode).toBe(WATCH_EXIT.settled);
		expect(JSON.parse(result.stdout.toString().trim())).toMatchObject({ outcome: "settled", status: null });
	});
	test("a blocked Task and a stopped Task are different exit codes", () => {
		const { dir, paths } = fixture(); const a = launchTeamAgent(paths, { focus: "Blocked run" }, false);
		const c = claimTestWork(paths, { goalId: a.goal_id, workerExecutionId: a.execution_id, work: a.focus });
		submitReceipt(paths, { commitmentId: c.id, status: "blocked", summary: "External dependency missing",
			remaining: ["Provision the dependency"] });
		completeAgentExecution(paths, a.agent_id, a.execution_id, { status: "idle", summary: "Blocked", exit_code: 0 });
		finishTeam(paths, "blocked", "External dependency missing", ["Provision the dependency"]);
		const result = Bun.spawnSync(["bash", path.join(root, "runtime/bin/codeteam"), "watch", paths.runId, "--quiet"], {
			cwd: dir, env: { ...process.env, CODEFLOW_RUNS_DIR: paths.code }, stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode).toBe(WATCH_EXIT.blocked);
		expect(JSON.parse(result.stdout.toString().trim())).toMatchObject({ status: "blocked", remaining: ["Provision the dependency"] });
	});
});
