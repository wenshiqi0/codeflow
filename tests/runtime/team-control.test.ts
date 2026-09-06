import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunPaths, writeJsonAtomic } from "../../runtime/lib/paths";
import { beginAgentExecution, completeAgentExecution, createTeam, createTeamGoal, finishTeam, launchTeamAgent, loadAgent, stopTeamAgents, teamStatus, validateTeamAgentStartup } from "../../runtime/lib/team";
import { claimTestWork } from "./helpers";
import { commitmentHistory, submitReceipt } from "../../runtime/lib/commitment";
import { taskState } from "../../runtime/lib/state";
import { scan } from "../../runtime/lib/wait";
import { classify } from "../../runtime/cli/outer";

const directories: string[] = [];
const saved = { ...process.env };
afterEach(() => {
	for (const key of Object.keys(process.env)) if (key.startsWith("CODEFLOW_")) delete process.env[key];
	for (const [key, value] of Object.entries(saved)) if (key.startsWith("CODEFLOW_") && value !== undefined) process.env[key] = value;
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture(capacity = 2) {
	for (const key of Object.keys(process.env)) if (key.startsWith("CODEFLOW_")) delete process.env[key];
	process.env.CODEFLOW_MAX_CONCURRENT_AGENTS = String(capacity);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-control-")); directories.push(dir);
	const paths = new RunPaths(path.join(dir, "runs"), "task-control");
	createTeam(paths, "Ship a verified result", dir, "offline/agent"); return { dir, paths };
}
function finishAssignment(paths: RunPaths, agent: ReturnType<typeof launchTeamAgent>) {
	const claim = claimTestWork(paths, { goalId: agent.goal_id, workerExecutionId: agent.execution_id, work: agent.focus });
	submitReceipt(paths, { commitmentId: claim.id, status: "completed", summary: "Verified assigned work" });
	completeAgentExecution(paths, agent.agent_id, agent.execution_id, { status: "idle", summary: "Assignment ended", exit_code: 0 });
	return claim;
}

describe("outer-owned Task control", () => {
	test("audit observes outer Agent lifecycle without expecting an inner Manager", async () => {
		const { paths } = fixture();
		const agent = launchTeamAgent(paths, { focus: "Work in progress" }, false);
		claimTestWork(paths, { goalId: agent.goal_id, workerExecutionId: agent.execution_id, work: agent.focus });
		const audit = async (force = false) => {
			const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../runtime/cli/outer.ts"), "audit", paths.runId, ...(force ? ["--force"] : [])], {
				env: { ...process.env, CODEFLOW_RUNS_DIR: paths.code }, stdout: "pipe", stderr: "pipe",
			});
			return { exit: await child.exited, output: await new Response(child.stdout).text(), error: await new Response(child.stderr).text() };
		};
		const healthy = await audit();
		expect(healthy.exit).toBe(1); expect(healthy.error).toContain("healthy and progressing");
		const forced = await audit(true);
		expect(forced.exit).toBe(0); expect(JSON.parse(forced.output)).toMatchObject({ trigger: "forced", run_status: "open", agents: [{ agent_id: agent.agent_id }] });
		const file = path.join(paths.runDir, "agents", agent.agent_id, "agent.json");
		writeJsonAtomic(file, { ...agent, owner_pid: 2_000_000_000 });
		expect(JSON.parse((await audit()).output).trigger).toBe("dead_runner");
		writeJsonAtomic(file, { ...agent, status: "interrupted" });
		expect(JSON.parse((await audit()).output).trigger).toBe("interrupted_agent");
	});

	test("concurrent outer callers share one exact capacity limit", async () => {
		const { paths } = fixture(2);
		const script = `import { launchTeamAgent } from ${JSON.stringify(path.resolve(import.meta.dir, "../../runtime/lib/team.ts"))};
import { RunPaths } from ${JSON.stringify(path.resolve(import.meta.dir, "../../runtime/lib/paths.ts"))};
try { launchTeamAgent(new RunPaths(${JSON.stringify(paths.code)}, ${JSON.stringify(paths.runId)}), {focus: 'Independent work'}, false); }
catch (error) { console.error(error.message); process.exitCode = 1; }`;
		const results = await Promise.all(Array.from({ length: 6 }, async () => {
			const child = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "pipe" });
			return { exit: await child.exited, error: await new Response(child.stderr).text() };
		}));
		expect(results.filter(r => r.exit === 0)).toHaveLength(2);
		expect(results.filter(r => r.exit !== 0).every(r => r.error.includes("capacity reached"))).toBe(true);
		expect(teamStatus(paths).agents).toHaveLength(2);
		await stopTeamAgents(paths);
		expect(teamStatus(paths).agents.every(a => a.status === "interrupted")).toBe(true);
	});

	test("damaged process identities, capacity, and private session paths fail closed", async () => {
		const { paths } = fixture();
		const agent = launchTeamAgent(paths, { focus: "Work" }, false);
		const file = path.join(paths.runDir, "agents", agent.agent_id, "agent.json");
		for (const pid of [0, -10, 1.5, 2_147_483_648]) {
			writeJsonAtomic(file, { ...agent, pid });
			expect(() => loadAgent(paths, agent.agent_id)).toThrow(/malformed Agent/);
			await expect(stopTeamAgents(paths, agent.agent_id)).rejects.toThrow(/malformed Agent/);
		}
		writeJsonAtomic(file, { ...agent, session_path: path.join(paths.runDir, "other.jsonl") });
		expect(() => loadAgent(paths, agent.agent_id)).toThrow(/private session/);
		writeJsonAtomic(file, agent);
		const teamFile = path.join(paths.runDir, "team.json");
		const original = JSON.parse(fs.readFileSync(teamFile, "utf8"));
		writeJsonAtomic(teamFile, { ...original, max_concurrent_agents: null });
		expect(() => launchTeamAgent(paths, { focus: "Invalid capacity" }, false)).toThrow(/malformed outer/);
	});

	test("stale PID birth data cannot signal an unrelated live process group", async () => {
		const { paths } = fixture();
		const target = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		try {
			const agent = launchTeamAgent(paths, { focus: "Work" }, false);
			const file = path.join(paths.runDir, "agents", agent.agent_id, "agent.json");
			writeJsonAtomic(file, { ...agent, pid: target.pid, process_started_at: "a different process birth" });
			await expect(stopTeamAgents(paths, agent.agent_id)).rejects.toThrow(/possibly reused/);
			expect(target.exitCode).toBeNull();
		} finally { target.kill("SIGKILL"); await target.exited; }
	});

	test("start has no model process, and a root-Goal Receipt cannot finish the Task", () => {
		const { paths } = fixture();
		expect(teamStatus(paths)).toMatchObject({ status: "open", agents: [], open_commitments: [] });
		expect(classify(paths.code, paths.runId).status).toBe("open");
		const agent = launchTeamAgent(paths, { focus: "Implement one boundary" }, false);
		finishAssignment(paths, agent);
		expect(scan(paths.events, 0, ["run_finished"]).events).toEqual([]);
		expect(taskState(paths).status).toBe("pending");
		expect(finishTeam(paths, "completed", "Reviewed integrated result").status).toBe("completed");
		expect(scan(paths.events, 0, ["run_finished"]).events).toHaveLength(1);
		expect(taskState(paths).status).toBe("completed");
		expect(() => launchTeamAgent(paths, { focus: "Too late" }, false)).toThrow(/already completed/);
	});
	test("capacity counts reserved work; busy followup is rejected without queueing or rewriting focus", () => {
		const { paths } = fixture(1);
		const agent = launchTeamAgent(paths, { focus: "Original work" }, false);
		expect(() => launchTeamAgent(paths, { focus: "Conflicting work", mode: "followup", agentId: agent.agent_id }, false)).toThrow(/busy/);
		expect(() => launchTeamAgent(paths, { focus: "Another Agent" }, false)).toThrow(/capacity/);
		expect(loadAgent(paths, agent.agent_id).focus).toBe("Original work");
		expect(teamStatus(paths).agents).toHaveLength(1);
		finishAssignment(paths, agent);
		expect(launchTeamAgent(paths, { focus: "Now independent" }, false).agent_id).not.toBe(agent.agent_id);
	});
	test("followup requires real idle session and preserves Agent/Goal while changing execution", () => {
		const { paths, dir } = fixture();
		const agent = launchTeamAgent(paths, { focus: "Initial work" }, false); finishAssignment(paths, agent);
		expect(() => launchTeamAgent(paths, { agentId: agent.agent_id, mode: "followup", focus: "Related work" }, false)).toThrow(/no persisted Pi session/);
		writeJsonAtomic(agent.session_path, { type: "session", id: "test-session", cwd: dir });
		const next = launchTeamAgent(paths, { agentId: agent.agent_id, mode: "followup", focus: "Related work" }, false);
		expect(next.agent_id).toBe(agent.agent_id); expect(next.goal_id).toBe(agent.goal_id);
		expect(next.session_path).toBe(agent.session_path); expect(next.execution_id).not.toBe(agent.execution_id);
		expect(next.resume_commitment_id).toBeNull();
		// Completion from a previous assignment must not clear a replacement's slot.
		completeAgentExecution(paths, agent.agent_id, agent.execution_id, { status: "idle", summary: "late", exit_code: 0 });
		expect(loadAgent(paths, agent.agent_id).status).toBe("starting");
	});
	test("Goal dependencies are explicit and do not create an implicit waiting Agent", () => {
		const { paths } = fixture();
		createTeamGoal(paths, { id: "contract", objective: "Establish the contract" });
		createTeamGoal(paths, { id: "implementation", objective: "Implement it", dependencies: ["contract"] });
		expect(() => launchTeamAgent(paths, { goalId: "implementation", focus: "Implement" }, false)).toThrow(/dependencies/);
		expect(teamStatus(paths).agents).toEqual([]);
		const agent = launchTeamAgent(paths, { goalId: "contract", focus: "Establish contract" }, false); finishAssignment(paths, agent);
		expect(launchTeamAgent(paths, { goalId: "implementation", focus: "Implement" }, false).goal_id).toBe("implementation");
	});
	test("finish checks executions and open work rather than inferring completion from a stopped process", async () => {
		const { paths } = fixture();
		expect(() => finishTeam(paths, "completed", "No evidence")).toThrow(/actual completed/);
		const agent = launchTeamAgent(paths, { focus: "Unfinished" }, false);
		expect(() => finishTeam(paths, "blocked", "Not yet", ["Work"])).toThrow(/execution to stop/);
		const claim = claimTestWork(paths, { goalId: paths.runId, workerExecutionId: agent.execution_id, work: "Unfinished", pid: 2_000_000_000 });
		await stopTeamAgents(paths, agent.agent_id);
		expect(commitmentHistory(paths)[0].folded.terminal).toBeNull();
		expect(() => finishTeam(paths, "completed", "Process stopped")).toThrow(/open Commitment/);
		const resumed = launchTeamAgent(paths, { mode: "resume", agentId: agent.agent_id, focus: "Recover original work" }, false);
		expect(resumed.resume_commitment_id).toBe(claim.id); expect(resumed.session_path).not.toBe(agent.session_path);
	});
	test("stopped reservations and duplicate runners cannot start Pi or overwrite an Agent", async () => {
		const { paths } = fixture();
		const agent = launchTeamAgent(paths, { focus: "Work" }, false);
		beginAgentExecution(paths, agent.agent_id, agent.execution_id, process.pid);
		expect(() => beginAgentExecution(paths, agent.agent_id, agent.execution_id, process.pid)).toThrow(/already started/);
		process.env.CODEFLOW_TEAM_RUNNER_PID = "1";
		expect(() => validateTeamAgentStartup(paths, agent.agent_id, agent.execution_id)).toThrow(/identity mismatch/);
		// Simulate completed controlled exit, then fence an unstarted follow-on reservation.
		completeAgentExecution(paths, agent.agent_id, agent.execution_id, { status: "interrupted", summary: "Stopped", exit_code: 1 });
		const next = launchTeamAgent(paths, { mode: "resume", agentId: agent.agent_id, focus: "Fresh retry" }, false);
		await stopTeamAgents(paths, next.agent_id);
		expect(() => beginAgentExecution(paths, next.agent_id, next.execution_id, process.pid)).toThrow(/no longer reserved/);
	});
	test("Pi uses the same control API and retains capacity and finish checks", async () => {
		const { paths } = fixture(1);
		process.env.CODEFLOW_EXECUTION_ID = "exec-inner";
		process.env.CODEFLOW_TEAM_AGENT_ID = "agent-inner";
		createTeamGoal(paths, { id: "additional", objective: "Additional work" });
		const agent = launchTeamAgent(paths, { goalId: "additional", focus: "Work" }, false);
		expect(teamStatus(paths).agents.map(a => a.agent_id)).toEqual([agent.agent_id]);
		expect(() => launchTeamAgent(paths, { focus: "Above capacity" }, false)).toThrow(/capacity/);
		expect(() => finishTeam(paths, "blocked", "Not done", ["work"])).toThrow(/execution to stop/);
		await stopTeamAgents(paths, agent.agent_id);
		expect(finishTeam(paths, "blocked", "No completed work", ["work"]).status).toBe("blocked");
	});
});
