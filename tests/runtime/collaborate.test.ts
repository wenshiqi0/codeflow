import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Value } from "typebox/value";
import organization, { registerTeamRunnerSupervisor } from "../../runtime/extensions/codeflow-organization";
import { commitmentHistory, loadReceiptChain, submitReceipt } from "../../runtime/lib/commitment";
import { createGoal } from "../../runtime/lib/goals";
import { goalState } from "../../runtime/lib/state";
import { createTask } from "../../runtime/lib/tasks";
import { RunPaths } from "../../runtime/lib/paths";
import { scan } from "../../runtime/lib/wait";
import { claimTestWork } from "./helpers";

const dirs: string[] = [];
const ENV_KEYS = [
	"CODEFLOW_RUN_ID", "CODEFLOW_RUNS_DIR", "CODEFLOW_GOAL_ID", "CODEFLOW_EXECUTION_ID",
	"CODEFLOW_COMMITMENT_ID", "CODEFLOW_PARENT_COMMITMENT_ID", "CODEFLOW_PROCESS_KIND",
	"CODEFLOW_TEAM_AGENT_ID", "CODEFLOW_TEAM_RUNNER_PID",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	for (const key of ENV_KEYS) {
		const value = originalEnv[key];
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
});

function runtime(kind: "root" | "worker" = "worker") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-collaborate-"));
	dirs.push(root);
	const paths = new RunPaths(path.join(root, "runs"), "task-collaborate");
	createTask(paths, "execute bounded work safely");
	process.env.CODEFLOW_RUN_ID = paths.runId;
	process.env.CODEFLOW_RUNS_DIR = paths.code;
	process.env.CODEFLOW_GOAL_ID = paths.runId;
	process.env.CODEFLOW_EXECUTION_ID = `exec-${kind}`;
	process.env.CODEFLOW_PROCESS_KIND = kind;
	for (const key of ["CODEFLOW_COMMITMENT_ID", "CODEFLOW_PARENT_COMMITMENT_ID", "CODEFLOW_TEAM_AGENT_ID", "CODEFLOW_TEAM_RUNNER_PID"]) delete process.env[key];
	let tool: any;
	const hooks: string[] = [];
	organization({ on(name: string) { hooks.push(name); }, registerTool(value: unknown) { tool = value; } } as never);
	return { paths, root, tool, hooks };
}
async function execute(tool: any, action: Record<string, unknown>) {
	const input = { action };
	if (!Value.Check(tool.parameters, input)) throw new Error("test supplied an invalid collaborate action");
	return tool.execute("call", input, undefined, undefined, {});
}
function body(result: any): any { return JSON.parse(result.content[0].text); }

describe("executor-only collaborate protocol", () => {
	test.each(["root", "worker"] as const)("%s has three actions and no scheduling lifecycle hooks", async (kind) => {
		const { tool, hooks } = runtime(kind);
		expect(tool.parameters.properties.action.anyOf.map((entry: any) => entry.properties.name.const)).toEqual(["inspect", "claim", "report"]);
		for (const action of ["delegate", "wait", "spawn", "message", "followup", "finish"]) {
			expect(Value.Check(tool.parameters, { action: { name: action } })).toBe(false);
			await expect(tool.execute("call", { action: { name: action } })).rejects.toThrow("unknown collaborate action");
		}
		expect(hooks).toEqual([]);
		expect(tool.promptSnippet).toBeUndefined();
		expect(tool.promptGuidelines).toBeUndefined();
	});
	test("schema preserves the small self-authored claim and report surfaces", () => {
		const { tool } = runtime();
		const byName = new Map((tool.parameters.properties.action.anyOf as any[]).map((variant) => [variant.properties.name.const, variant]));
		expect(Object.keys(byName.get("inspect").properties)).toEqual(["name", "goal_id", "commitment_id", "receipt_id"]);
		expect(Object.keys(byName.get("claim").properties)).toEqual(["name", "work", "done_when", "constraints"]);
		expect(byName.get("claim").required).toEqual(["name", "work"]);
		expect(Object.keys(byName.get("report").properties)).toEqual(["name", "status", "summary", "effects", "remaining"]);
		expect(byName.get("report").required).toEqual(["name", "status", "summary"]);
		expect(JSON.stringify(tool.parameters)).not.toMatch(/claim_revision|invariant|falsification|obligation|decomposition|resolved|partial|superseded/);
		expect(Value.Check(tool.parameters, { action: { name: "claim", work: "bounded work" } })).toBe(true);
		expect(Value.Check(tool.parameters, { action: { name: "claim" } })).toBe(false);
	});
	test("an executor claims, reports progress, completes and recalls evidence", async () => {
		const { paths, tool } = runtime();
		expect(body(await execute(tool, { name: "inspect" })).goal.goal_id).toBe(paths.runId);
		const claimed = body(await execute(tool, { name: "claim", work: "repair the parser", done_when: ["regression passes"] }));
		await execute(tool, { name: "report", status: "progress", summary: "isolated the failure", remaining: ["repair and verify"] });
		expect(loadReceiptChain(paths, claimed.commitment_id).terminal).toBeNull();
		const receipt = body(await execute(tool, { name: "report", status: "completed", summary: "parser repaired and verified", effects: [{ file: "src/parser.ts" }], remaining: ["prompt sync remains for the outer caller"] }));
		const folded = loadReceiptChain(paths, claimed.commitment_id);
		expect(folded.terminal?.id).toBe(receipt.receipt_id);
		expect(folded.terminal?.status).toBe("completed");
		expect(folded.remaining).toEqual(["prompt sync remains for the outer caller"]);
		const recalled = body(await execute(tool, { name: "inspect", receipt_id: receipt.receipt_id }));
		expect(recalled.commitment.id).toBe(claimed.commitment_id);
		expect(recalled.receipt.summary).toBe("parser repaired and verified");
		expect(recalled.receipt.remaining).toEqual(["prompt sync remains for the outer caller"]);
		await expect(execute(tool, { name: "inspect", commitment_id: claimed.commitment_id, receipt_id: receipt.receipt_id })).rejects.toThrow(/at most one/);
	});
	test("pre-claim blockers prevent fabricated claims and only blocked is accepted", async () => {
		const { paths, tool } = runtime();
		await expect(execute(tool, { name: "report", status: "completed", summary: "nothing done" })).rejects.toThrow(/pre-claim report must be blocked/);
		const report = body(await execute(tool, { name: "report", status: "blocked", summary: "assignment needs clarification", remaining: ["outer caller must revise the boundary"] }));
		expect(report.execution_id).toBe("exec-worker");
		expect(scan(paths.events, 0, ["worker_reported"]).events).toHaveLength(1);
		await expect(execute(tool, { name: "claim", work: "fabricated work" })).rejects.toThrow(/reported a blocker/);
		expect(commitmentHistory(paths)).toHaveLength(0);
	});
	test("an open resumed Commitment cannot be replaced with a fresh claim", async () => {
		const { paths, tool } = runtime();
		const commitment = claimTestWork(paths, { goalId: paths.runId, workerExecutionId: "exec-worker", work: "original work" });
		process.env.CODEFLOW_COMMITMENT_ID = commitment.id;
		await expect(execute(tool, { name: "claim", work: "narrow replacement" })).rejects.toThrow(/still open/);
		expect(body(await execute(tool, { name: "report", status: "completed", summary: "original work reconciled" })).status).toBe("completed");
	});
	test("a claimed Goal still respects unmet dependencies", async () => {
		const { paths, tool } = runtime();
		createGoal(paths, { id: "dependency", objective: "establish prerequisite" });
		createGoal(paths, { id: "dependent", objective: "use prerequisite", dependencies: ["dependency"] });
		process.env.CODEFLOW_GOAL_ID = "dependent";
		await expect(execute(tool, { name: "claim", work: "too early" })).rejects.toThrow(/dependencies are not completed/);
		const prior = claimTestWork(paths, { goalId: "dependency", work: "establish prerequisite" });
		submitReceipt(paths, { commitmentId: prior.id, status: "completed", summary: "prerequisite established" });
		expect(body(await execute(tool, { name: "claim", work: "use prerequisite" })).goal_id).toBe("dependent");
	});
	test("a completed Receipt with remaining leaves the Goal claimable for a fresh execution", async () => {
		const { paths, tool } = runtime();
		const first = body(await execute(tool, { name: "claim", work: "first pass" }));
		await execute(tool, { name: "report", status: "completed", summary: "first pass complete", remaining: ["second pass remains"] });
		const closed = goalState(paths, paths.runId);
		expect(closed.status).toBe("pending");
		expect(closed.remaining).toEqual(["second pass remains"]);
		delete process.env.CODEFLOW_COMMITMENT_ID;
		process.env.CODEFLOW_EXECUTION_ID = "exec-followup";
		process.env.CODEFLOW_PARENT_COMMITMENT_ID = "obsolete-parent";
		const second = body(await execute(tool, { name: "claim", work: "follow-up from new evidence" }));
		expect(second.commitment_id).not.toBe(first.commitment_id);
		expect(commitmentHistory(paths).map((view) => view.commitment.goal_id)).toEqual([paths.runId, paths.runId]);
		expect(commitmentHistory(paths).every((view) => view.commitment.parent_commitment_id === null)).toBe(true);
	});
});

describe("outer runner orphan supervision", () => {
	test("startup admission failure exits before tool registration or any provider work", () => {
		const { paths } = runtime();
		const source = `import organization from ${JSON.stringify(path.resolve(import.meta.dir, "../../runtime/extensions/codeflow-organization/index.ts"))}; organization({ on() {}, registerTool() { console.log("UNSAFE_TOOL_REGISTRATION"); } }); console.log("UNSAFE_CONTINUATION");`;
		const probe = Bun.spawnSync([process.execPath, "-e", source], {
			env: { ...process.env, CODEFLOW_RUN_ID: paths.runId, CODEFLOW_TEAM_AGENT_ID: "missing-agent", CODEFLOW_TEAM_RUNNER_PID: String(process.pid) },
		});
		expect(probe.exitCode).toBe(1);
		expect(probe.stderr.toString()).toContain("Agent startup rejected");
		expect(probe.stdout.toString()).not.toContain("UNSAFE_");
	});

	test("runner death signals Pi gracefully before a bounded hard-stop backstop", async () => {
		let alive = true;
		const calls: unknown[] = [];
		const stop = registerTeamRunnerSupervisor({ on() {} } as never, 1234, {
			pid: 5678, intervalMs: 2, killGraceMs: 2, alive: (pid) => { expect(pid).toBe(1234); return alive; },
			kill: (pid, signal) => calls.push([pid, signal]),
		});
		try {
			await Bun.sleep(10); expect(calls).toEqual([]);
			alive = false;
			await Bun.sleep(20); expect(calls).toEqual([[-5678, "SIGTERM"], [-5678, "SIGKILL"]]);
		} finally { stop(); }
	});
	test("shutdown disposes supervision and invalid runner identities fail closed", async () => {
		let shutdown: (() => void) | undefined;
		let probes = 0;
		registerTeamRunnerSupervisor({ on(_event: string, handler: () => void) { shutdown = handler; } } as never, 1234, {
			pid: 5678, intervalMs: 2, alive: () => { probes++; return false; }, kill() { throw new Error("unexpected kill"); },
		});
		shutdown!(); await Bun.sleep(10); expect(probes).toBe(0);
		for (const runnerPid of [0, -1, NaN, 5678, 2_147_483_648]) {
			expect(() => registerTeamRunnerSupervisor({ on() {} } as never, runnerPid, { pid: 5678 })).toThrow(/runner PID/);
		}
	});
});
