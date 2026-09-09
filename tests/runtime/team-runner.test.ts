import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentExitReasons, classifyAgentCompletion, validateAgentSession } from "../../runtime/cli/team-runner";
import { claimCommitment, commitmentHistory, goalClaimRevision, submitReceipt } from "../../runtime/lib/commitment";
import { RunPaths } from "../../runtime/lib/paths";
import { createTeam, finishTeam, launchTeamAgent, loadAgent, stopTeamAgents, teamStatus, type TeamAgent } from "../../runtime/lib/team";
import { listTeamTools } from "../../runtime/lib/team-tools";
import { readUsageRecords } from "../../runtime/lib/usage";
import type { TeamWatchMessage } from "../../runtime/lib/team-watch";

const repository = path.resolve(import.meta.dir, "../..");
const directories: string[] = [];
const children = new Set<Bun.Subprocess>();
const piPids = new Set<number>();

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}
async function until(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("offline team runner condition timed out");
		await Bun.sleep(25);
	}
}
afterEach(async () => {
	for (const child of children) if (child.exitCode === null) {
		try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
	}
	for (const pid of piPids) { try { process.kill(-pid, "SIGKILL"); } catch { /* Already reaped. */ } }
	await Promise.all([...children].map((child) => child.exited));
	children.clear(); piPids.clear();
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-team-runner-"));
	directories.push(dir);
	const paths = new RunPaths(path.join(dir, "runs"), "task-offline-team");
	createTeam(paths, "Offline execution-only Agent lifecycle", dir, "team-offline/agent");
	return { dir, paths };
}

/** Generated only inside the temporary fixture; all model responses are local. */
function installOfflinePi(dir: string): string {
	const file = path.join(dir, "offline-pi.ts");
	fs.mkdirSync(path.join(dir, "pi"));
	fs.writeFileSync(path.join(dir, "pi/settings.json"), JSON.stringify({ retry: { enabled: false } }));
	fs.writeFileSync(file, `
import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(path.join(repository, "node_modules/@earendil-works/pi-ai/dist/index.js"))};
import { loadTerminalReceipt } from ${JSON.stringify(path.join(repository, "runtime/lib/commitment/index.ts"))};
import { loadWorkerReport } from ${JSON.stringify(path.join(repository, "runtime/lib/executions.ts"))};
import { RunPaths } from ${JSON.stringify(path.join(repository, "runtime/lib/paths.ts"))};
const file = ${JSON.stringify(file)};
if (import.meta.main) {
  process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(path.join(dir, "pi"))};
  process.argv.push("--extension", file);
  await import(${JSON.stringify(path.join(repository, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"))});
}
export default function offlineAgent(pi) {
  const paths = new RunPaths(process.env.CODEFLOW_RUNS_DIR, process.env.CODEFLOW_RUN_ID);
  const execution = process.env.CODEFLOW_EXECUTION_ID;
  const focus = process.env.CODEFLOW_WORK_FOCUS;
  const trace = (kind, extra = {}) => fs.appendFileSync(${JSON.stringify(path.join(dir, "trace.jsonl"))}, JSON.stringify({ kind, execution, focus, pid: process.pid, ...extra }) + "\\n");
  let progressed = false;
  let dispatched = false;
  const provider = fauxProvider({ api: "team-offline-api", provider: "team-offline", models: [{ id: "agent", name: "Offline Team Agent", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] });
  provider.setResponses(Array.from({ length: 12 }, () => async (context, options) => {
    const id = process.env.CODEFLOW_COMMITMENT_ID;
    const restoredMarker = context.messages.some(message => message.role === "assistant" && message.content.some(item => item.type === "text" && item.text.startsWith("PUBLIC_AGENT_MEMORY:")));
    trace("provider_call", { restored_marker: restoredMarker, commitment_id: id ?? null });
    if (focus === "no-claim") return fauxAssistantMessage([{ type: "text", text: "No work was claimed." }]);
    if (focus === "preclaim-blocked") return loadWorkerReport(paths, execution)
      ? fauxAssistantMessage([{ type: "text", text: "PUBLIC_AGENT_MEMORY:" + execution }])
      : fauxAssistantMessage([fauxToolCall("collaborate", { action: { name: "report", status: "blocked", summary: "A requirement is missing", remaining: ["Clarify the missing requirement"] } })]);
    if (!id) return fauxAssistantMessage([fauxToolCall("collaborate", { action: { name: "claim", work: focus } })]);
    if (focus === "staged-progress" && !progressed) {
      progressed = true;
      return fauxAssistantMessage([fauxToolCall("collaborate", { action: { name: "report", status: "progress", summary: "Reproduction established; verifying the implementation", remaining: ["Complete verification"] } })]);
    }
    if (!dispatched && (focus === "spawn-peer" || focus.startsWith("followup-peer:"))) {
      dispatched = true;
      const args = focus === "spawn-peer" ? ["spawn", paths.runId, "peer-work"]
        : ["followup", paths.runId, focus.slice("followup-peer:".length), "peer-followup"];
      const command = [${JSON.stringify(path.join(repository, "runtime/bin/codeteam"))}, ...args].map(value => JSON.stringify(value)).join(" ");
      return fauxAssistantMessage([fauxToolCall("bash", { command })]);
    }
    if (focus === "hold-bash") return fauxAssistantMessage([fauxToolCall("bash", { command: "echo $$ > " + JSON.stringify(path.join(process.env.CODEFLOW_PROJECT_DIR, "shell.pid")) + "; sleep 60" })]);
    if (focus === "hold" && !loadTerminalReceipt(paths, id)) {
      trace("holding", { commitment_id: id });
      await new Promise(resolve => { const timer = setInterval(() => { if (options?.signal?.aborted) { clearInterval(timer); resolve(); } }, 10); });
      return fauxAssistantMessage([], { stopReason: "aborted" });
    }
    if (!loadTerminalReceipt(paths, id) && !(focus === "progress-only" && progressed)) {
      progressed = true;
      return fauxAssistantMessage([fauxToolCall("collaborate", { action: { name: "report", status: focus === "progress-only" ? "progress" : "completed", summary: "Offline evidence for " + focus, remaining: ["follow-up verification remains for the outer caller"] } })]);
    }
    return fauxAssistantMessage([{ type: "text", text: "PUBLIC_AGENT_MEMORY:" + execution }]);
  }));
  pi.registerProvider(provider.provider);
  pi.on("tool_result", event => {
    if (event.toolName === "collaborate") trace("tool_result", { is_error: event.isError, action: event.input.action.name });
    if (event.toolName === "bash") trace("bash_result", { is_error: event.isError });
  });
  pi.on("session_shutdown", () => trace("shutdown"));
}
`);
	return file;
}

function launch(f: ReturnType<typeof fixture>, agent: TeamAgent, cli: string) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("CODEFLOW_")) delete env[key];
	const child = Bun.spawn([process.execPath, path.join(repository, "runtime/cli/team-runner.ts"), f.paths.code,
		f.paths.runId, agent.agent_id, agent.execution_id], {
		cwd: f.dir, env: { ...env, CODEFLOW_PI_CLI: cli, CODEFLOW_HOME: path.join(f.dir, "empty-config") },
		stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
	});
	children.add(child);
	const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	return { child, output };
}

function trace(dir: string): Array<Record<string, any>> {
	try { return fs.readFileSync(path.join(dir, "trace.jsonl"), "utf8").split("\n").filter(Boolean).flatMap(line => {
		try { const event = JSON.parse(line); piPids.add(event.pid); return [event]; } catch { return []; }
	}); } catch { return []; }
}

async function completed(run: ReturnType<typeof launch>, f: ReturnType<typeof fixture>, agent: TeamAgent, code = 0) {
	await until(() => run.child.exitCode !== null);
	const [stdout, stderr] = await run.output;
	expect(stderr).not.toContain("Extension error");
	expect(stderr).not.toContain("No more responses");
	if (run.child.exitCode !== code) throw new Error(`runner exited ${run.child.exitCode}: ${stderr}\n${stdout.slice(-4000)}`);
	const state = loadAgent(f.paths, agent.agent_id);
	expect(state.pid).toBeNull();
	expect(state.runner_pid).toBeNull();
	expect(trace(f.dir).filter(event => event.execution === agent.execution_id && event.kind === "tool_result" && event.is_error)).toEqual([]);
	return { state, stdout, stderr };
}

describe("outer Agent runner", () => {
	test("SIGTERM to the watch CLI leaves the real Pi and its open Commitment running", async () => {
		const f = fixture(); const cli = installOfflinePi(f.dir);
		const agent = launchTeamAgent(f.paths, { focus: "hold" }, false);
		const run = launch(f, agent, cli);
		await until(() => trace(f.dir).some(event => event.kind === "holding"));
		const observer = Bun.spawn(["bash", path.join(repository, "runtime/bin/codeteam"), "watch", f.paths.runId], {
			cwd: f.dir, env: { ...process.env, CODEFLOW_RUNS_DIR: f.paths.code },
			stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
		});
		children.add(observer);
		const reader = observer.stdout.getReader();
		try {
			const first = await reader.read(); expect(new TextDecoder().decode(first.value)).toContain('"type":"watching"');
			observer.kill("SIGTERM"); expect(await observer.exited).toBe(0);
			expect(await new Response(observer.stderr).text()).toBe("");
			expect(run.child.exitCode).toBeNull();
			const state = loadAgent(f.paths, agent.agent_id);
			expect(state.status).toBe("running"); expect(alive(state.pid!)).toBe(true);
			expect(teamStatus(f.paths).open_commitments).toHaveLength(1);
		} finally {
			reader.releaseLock();
			if (observer.exitCode === null) observer.kill("SIGTERM");
			await stopTeamAgents(f.paths, agent.agent_id);
			await run.child.exited; await run.output;
		}
	}, 30_000);

	test("one observer spans real Pi progress, idle, and same-session followup without usage chatter", async () => {
		const f = fixture(); const cli = installOfflinePi(f.dir);
		const agent = launchTeamAgent(f.paths, { focus: "staged-progress" }, false);
		const messages: TeamWatchMessage[] = [];
		const observer = Bun.spawn(["bash", path.join(repository, "runtime/bin/codeteam"), "watch", f.paths.runId, "--idle", "30"], {
			cwd: f.dir, env: { ...process.env, CODEFLOW_RUNS_DIR: f.paths.code, CODEFLOW_HOME: path.join(f.dir, "empty-config") },
			stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
		});
		children.add(observer);
		const observerErrors = new Response(observer.stderr).text();
		const stream = (async () => {
			let pending = ""; const decoder = new TextDecoder();
			for await (const chunk of observer.stdout) {
				pending += decoder.decode(chunk, { stream: true });
				const lines = pending.split("\n"); pending = lines.pop()!;
				for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
			}
			expect(pending.trim()).toBe("");
		})();
		try {
			await until(() => messages.some(message => message.type === "watching"));
			await completed(launch(f, agent, cli), f, agent);
			await until(() => messages.some(message => message.type === "settled"));
			expect(messages.some((message: any) => message.event?.status === "PROGRESS")).toBe(true);
			expect(observer.exitCode).toBeNull();
			const next = launchTeamAgent(f.paths, { mode: "followup", agentId: agent.agent_id, focus: "Related verification" }, false);
			await completed(launch(f, next, cli), f, next);
			finishTeam(f.paths, "completed", "Offline Pi verification complete");
			expect(await observer.exited).toBe(0); await stream;
			expect(await observerErrors).toBe("");
			expect(messages.filter(message => message.type === "watching")).toHaveLength(1);
			expect(messages.filter(message => message.type === "attention")).toHaveLength(0);
			expect(messages.filter(message => message.type === "assignment").map((message: any) => message.assignment.focus))
				.toEqual(["staged-progress", "Related verification"]);
			const usage = readUsageRecords(f.paths);
			expect(new Set(usage.map(row => row.agent_id))).toEqual(new Set([agent.agent_id]));
			expect(new Set(usage.map(row => row.execution_id))).toEqual(new Set([agent.execution_id, next.execution_id]));
			expect(usage.some(row => row.commitment_id === null)).toBe(true);
			expect(JSON.stringify(messages)).not.toContain('"total_tokens"');
			expect(trace(f.dir).find(event => event.execution === next.execution_id && event.kind === "provider_call")?.restored_marker).toBe(true);
		} finally {
			if (observer.exitCode === null) observer.kill("SIGTERM");
			await observer.exited; await stream;
		}
	}, 30_000);

	test.each(["spawn", "followup"] as const)("a real offline Pi can %s a peer through codeteam without sharing execution identity", async (mode) => {
		const f = fixture(); const cli = installOfflinePi(f.dir);
		let previous: TeamAgent | undefined;
		if (mode === "followup") {
			previous = launchTeamAgent(f.paths, { focus: "peer-original" }, false);
			await completed(launch(f, previous, cli), f, previous);
		}
		const caller = launchTeamAgent(f.paths, { focus: previous ? `followup-peer:${previous.agent_id}` : "spawn-peer" }, false);
		try {
			const result = await completed(launch(f, caller, cli), f, caller);
			expect(result.state.status).toBe("idle");
			expect(trace(f.dir).filter(event => event.execution === caller.execution_id && event.kind === "bash_result"))
				.toEqual([expect.objectContaining({ is_error: false })]);
			await until(() => {
				const state = teamStatus(f.paths); trace(f.dir);
				return state.agents.length === 2 && state.agents.every(agent => agent.status === "idle");
			});
			const state = teamStatus(f.paths);
			const peer = state.agents.find(agent => agent.agent_id !== caller.agent_id)!;
			expect(peer.execution_id).not.toBe(caller.execution_id);
			expect(peer.session_path).not.toBe(caller.session_path);
			expect(peer.goal_id).toBe(caller.goal_id);
			expect(state.status).toBe("open");
			expect(state.open_commitments).toEqual([]);
			const firstCall = trace(f.dir).find(event => event.kind === "provider_call" && event.execution === peer.execution_id);
			expect(firstCall?.commitment_id).toBeNull();
			expect(firstCall?.restored_marker).toBe(mode === "followup");
			if (previous) {
				expect(peer.agent_id).toBe(previous.agent_id);
				expect(peer.session_path).toBe(previous.session_path);
				expect(peer.execution_id).not.toBe(previous.execution_id);
			}
		} finally { await stopTeamAgents(f.paths); trace(f.dir); }
	}, 30_000);

	test("session reuse validates the explicit public header and rejects another cwd or lost history", () => {
		const f = fixture();
		const file = path.join(f.dir, "session.jsonl");
		expect(() => validateAgentSession({ mode: "spawn", session_path: file }, f.dir)).not.toThrow();
		expect(() => validateAgentSession({ mode: "followup", session_path: file }, f.dir)).toThrow();
		fs.writeFileSync(file, JSON.stringify({ type: "session", id: "stable", cwd: f.dir }) + "\n");
		expect(() => validateAgentSession({ mode: "followup", session_path: file }, f.dir)).not.toThrow();
		expect(() => validateAgentSession({ mode: "resume", session_path: file }, f.dir)).toThrow(/must not already exist/);
		fs.writeFileSync(file, JSON.stringify({ type: "session", id: "stable", cwd: repository }) + "\n");
		expect(() => validateAgentSession({ mode: "followup", session_path: file }, f.dir)).toThrow(/different project/);
		fs.writeFileSync(file, "not a session\n");
		expect(() => validateAgentSession({ mode: "followup", session_path: file }, f.dir)).toThrow();
	});

	test("every execution Commitment must terminate; progress and clean exits cannot fake idle", () => {
		const f = fixture();
		const execution = { execution_id: "exec-unit", resume_commitment_id: null };
		const observation = { exitCode: 0, cancelled: false, diagnostics: "" };
		expect(classifyAgentCompletion(f.paths, execution, observation).reasons).toEqual(["COMMITMENT_CLAIM_MISSING"]);
		const claim = (work: string) => claimCommitment(f.paths, { goalId: f.paths.runId, workerExecutionId: execution.execution_id,
			basedOnRevision: goalClaimRevision(f.paths, f.paths.runId), work });
		const first = claim("First work");
		submitReceipt(f.paths, { commitmentId: first.id, status: "completed", summary: "first done" });
		const second = claim("Second work");
		submitReceipt(f.paths, { commitmentId: second.id, status: "progress", summary: "not done" });
		expect(classifyAgentCompletion(f.paths, execution, observation).status).toBe("interrupted");
		submitReceipt(f.paths, { commitmentId: second.id, status: "completed", summary: "second done", remaining: ["follow-up remains for the outer caller"] });
		expect(classifyAgentCompletion(f.paths, execution, observation).status).toBe("idle");
		expect(classifyAgentCompletion(f.paths, execution, { ...observation, stopReason: "error" }).reasons).toEqual(["PROVIDER_FAILURE"]);
		expect(agentExitReasons({ ...observation, cancelled: true, diagnostics: "CODEFLOW_CONTEXT_BUDGET_EXCEEDED" })).toEqual(["CONTEXT_BUDGET_EXCEEDED"]);
	});

	test("real offline Pi followup retains its session ID and conversation while using a fresh execution and Claim", async () => {
		const f = fixture(); const cli = installOfflinePi(f.dir);
		const first = launchTeamAgent(f.paths, { focus: "first" }, false);
		const result = await completed(launch(f, first, cli), f, first);
		expect(result.state.status).toBe("idle");
		const header = JSON.parse(fs.readFileSync(first.session_path, "utf8").split("\n")[0]);
		const before = fs.readFileSync(first.session_path, "utf8");
		const next = launchTeamAgent(f.paths, { agentId: first.agent_id, mode: "followup", focus: "second" }, false);
		expect(next.execution_id).not.toBe(first.execution_id);
		expect(next.agent_id).toBe(first.agent_id);
		expect(next.session_path).toBe(first.session_path);
		await completed(launch(f, next, cli), f, next);
		const after = fs.readFileSync(next.session_path, "utf8");
		expect(JSON.parse(after.split("\n")[0]).id).toBe(header.id);
		expect(after.startsWith(before)).toBe(true);
		const firstNewCall = trace(f.dir).find(event => event.execution === next.execution_id && event.kind === "provider_call");
		expect(firstNewCall?.restored_marker).toBe(true);
		expect(firstNewCall?.commitment_id).toBeNull();
		const claims = commitmentHistory(f.paths);
		expect(claims).toHaveLength(2);
		expect(claims.every(view => view.folded.terminal?.status === "completed")).toBe(true);
		expect(claims[0].folded.terminal?.status).toBe("completed");
		expect(claims[0].folded.remaining).toEqual(["follow-up verification remains for the outer caller"]);
		expect(new Set(claims.map(view => view.commitment.worker_execution_id))).toEqual(new Set([first.execution_id, next.execution_id]));
	}, 40_000);

	test("explicit fresh-context resume finishes the original open Commitment without restoring the old transcript", async () => {
		const f = fixture(); const cli = installOfflinePi(f.dir);
		const first = launchTeamAgent(f.paths, { focus: "progress-only" }, false);
		const initial = await completed(launch(f, first, cli), f, first, 1);
		expect(initial.state.status).toBe("interrupted");
		const original = commitmentHistory(f.paths)[0];
		expect(original.folded.terminal).toBeNull();
		expect(original.folded.receipts).toHaveLength(1);
		const next = launchTeamAgent(f.paths, { agentId: first.agent_id, mode: "resume", focus: "finish remaining" }, false);
		expect(next.resume_commitment_id).toBe(original.commitment.id);
		expect(next.session_path).not.toBe(first.session_path);
		await completed(launch(f, next, cli), f, next);
		const firstResumedCall = trace(f.dir).find(event => event.execution === next.execution_id && event.kind === "provider_call");
		expect(firstResumedCall?.restored_marker).toBe(false);
		expect(firstResumedCall?.commitment_id).toBe(original.commitment.id);
		const history = commitmentHistory(f.paths);
		expect(history).toHaveLength(1);
		expect(history[0].folded.terminal?.status).toBe("completed");
		expect(history[0].commitment.worker_execution_id).toBe(first.execution_id);
	}, 40_000);

	test("busy reuse is rejected immediately and TERM reaps Pi before publishing interrupted", async () => {
		const f = fixture(); const cli = installOfflinePi(f.dir);
		const first = launchTeamAgent(f.paths, { focus: "hold" }, false);
		const run = launch(f, first, cli);
		await until(() => trace(f.dir).some(event => event.kind === "holding"));
		const pid = loadAgent(f.paths, first.agent_id).pid!;
		expect(alive(pid)).toBe(true);
		const start = Date.now();
		expect(() => launchTeamAgent(f.paths, { agentId: first.agent_id, mode: "followup", focus: "must not queue" }, false)).toThrow(/busy/);
		expect(Date.now() - start).toBeLessThan(500);
		run.child.kill("SIGTERM");
		const result = await completed(run, f, first, 1);
		expect(result.state.status).toBe("interrupted");
		expect(result.state.reasons).toContain("USER_CANCELLED");
		expect(alive(pid)).toBe(false);
		expect(commitmentHistory(f.paths)[0].folded.terminal).toBeNull();
	}, 30_000);

	test("a real Pi clean no-Claim exit is interrupted without fabricating a Receipt", async () => {
		const f = fixture(); const cli = installOfflinePi(f.dir);
		const first = launchTeamAgent(f.paths, { focus: "no-claim" }, false);
		const result = await completed(launch(f, first, cli), f, first, 1);
		expect(result.state.status).toBe("interrupted");
		expect(result.state.reasons).toEqual(["COMMITMENT_CLAIM_MISSING"]);
		expect(commitmentHistory(f.paths)).toHaveLength(0);
	}, 30_000);

	test("the production detached launcher can reuse a persisted pre-claim blocked Agent after clarification", async () => {
		const f = fixture(); const cli = installOfflinePi(f.dir);
		const previous = process.env.CODEFLOW_PI_CLI;
		function dispatch(input: Parameters<typeof launchTeamAgent>[1]) {
			process.env.CODEFLOW_PI_CLI = cli;
			try { return launchTeamAgent(f.paths, input); }
			finally {
				if (previous === undefined) delete process.env.CODEFLOW_PI_CLI;
				else process.env.CODEFLOW_PI_CLI = previous;
			}
		}
		const first = dispatch({ focus: "preclaim-blocked" });
		expect(first.runner_pid).not.toBeNull();
		piPids.add(first.runner_pid!);
		await until(() => ["idle", "interrupted"].includes(loadAgent(f.paths, first.agent_id).status));
		expect(loadAgent(f.paths, first.agent_id).status).toBe("idle");
		expect(commitmentHistory(f.paths)).toHaveLength(0);
		const header = JSON.parse(fs.readFileSync(first.session_path, "utf8").split("\n")[0]);
		const next = dispatch({ agentId: first.agent_id, mode: "followup", focus: "clarified requirement" });
		piPids.add(next.runner_pid!);
		await until(() => ["idle", "interrupted"].includes(loadAgent(f.paths, next.agent_id).status));
		expect(loadAgent(f.paths, next.agent_id).status).toBe("idle");
		expect(JSON.parse(fs.readFileSync(next.session_path, "utf8").split("\n")[0]).id).toBe(header.id);
		expect(trace(f.dir).find(event => event.execution === next.execution_id && event.kind === "provider_call")?.restored_marker).toBe(true);
		expect(commitmentHistory(f.paths)).toHaveLength(1);
		expect(commitmentHistory(f.paths)[0].folded.terminal?.status).toBe("completed");
	}, 40_000);

	test("runner SIGKILL causes Pi to reap its detached bash tool; outer stop reconciles the open Claim", async () => {
		const f = fixture(); const cli = installOfflinePi(f.dir);
		const first = launchTeamAgent(f.paths, { focus: "hold-bash" }, false);
		const run = launch(f, first, cli);
		const shellFile = path.join(f.dir, "shell.pid");
		await until(() => fs.existsSync(shellFile) && Number(fs.readFileSync(shellFile, "utf8")) > 0);
		const shellPid = Number(fs.readFileSync(shellFile, "utf8"));
		piPids.add(shellPid);
		const piPid = loadAgent(f.paths, first.agent_id).pid!;
		piPids.add(piPid);
		expect(alive(piPid)).toBe(true);
		expect(alive(shellPid)).toBe(true);
		run.child.kill("SIGKILL");
		await run.child.exited;
		await until(() => !alive(piPid) && !alive(shellPid));
		// An abruptly killed supervisor cannot publish completion. Explicit outer
		// recovery clears dead identities and preserves the original Claim.
		await stopTeamAgents(f.paths, first.agent_id);
		const state = loadAgent(f.paths, first.agent_id);
		expect(state.status).toBe("interrupted");
		expect(state.pid).toBeNull();
		expect(state.runner_pid).toBeNull();
		const claims = commitmentHistory(f.paths);
		expect(claims).toHaveLength(1);
		expect(claims[0].pid).toBeNull();
		expect(claims[0].folded.terminal).toBeNull();
		await run.output;
	}, 35_000);

	test("Pi SIGKILL cannot leave a writing shell alive before original-Commitment recovery", async () => {
		const f = fixture(); const cli = installOfflinePi(f.dir);
		const first = launchTeamAgent(f.paths, { focus: "hold-bash" }, false);
		const run = launch(f, first, cli);
		const shellFile = path.join(f.dir, "shell.pid");
		await until(() => fs.existsSync(shellFile) && Number(fs.readFileSync(shellFile, "utf8")) > 0);
		const shellPid = Number(fs.readFileSync(shellFile, "utf8")); piPids.add(shellPid);
		const piPid = loadAgent(f.paths, first.agent_id).pid!; piPids.add(piPid);
		const original = commitmentHistory(f.paths)[0].commitment.id;
		expect(listTeamTools(f.paths, first.execution_id)).toHaveLength(1);
		process.kill(piPid, "SIGKILL");
		const result = await completed(run, f, first, 1);
		expect(result.state.status).toBe("interrupted");
		expect(alive(shellPid)).toBe(false);
		expect(listTeamTools(f.paths, first.execution_id)).toEqual([]);
		const resumed = launchTeamAgent(f.paths, { agentId: first.agent_id, mode: "resume", focus: "finish after tool interruption" }, false);
		expect(resumed.resume_commitment_id).toBe(original);
		await completed(launch(f, resumed, cli), f, resumed);
		expect(commitmentHistory(f.paths)).toHaveLength(1);
		expect(commitmentHistory(f.paths)[0].folded.terminal?.status).toBe("completed");
	}, 35_000);
});
