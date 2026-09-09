import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunPaths, writeJsonAtomic } from "../../runtime/lib/paths";
import { assignmentView, beginAgentExecution, completeAgentExecution, createTeam, finishTeam, launchTeamAgent, loadAgent, teamStatus } from "../../runtime/lib/team";
import { appendUsageRecord, usageRecordFromMessage, type UsageRecord } from "../../runtime/lib/usage";
import { TeamActivityTracker, UsageActivityTail, watchTeam, type TeamWatchMessage } from "../../runtime/lib/team-watch";
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
function monitor(paths: RunPaths, idleMs = 10_000, since = 0) {
	const cancel = new AbortController(); const messages: TeamWatchMessage[] = []; let ended = false;
	const done = watchTeam(paths, { since, idleMs, pollIntervalMs: 10, signal: cancel.signal,
		processProbe: () => "alive", onMessage: m => messages.push(m) }).finally(() => { ended = true; });
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
