import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Value } from "typebox/value";
import organization from "../../runtime/extensions/codeflow-organization";
import {
	buildChildEnvironment,
	delegateWorker,
	spawnWorker,
	waitForWorker,
} from "../../runtime/extensions/codeflow-organization/worker-launcher";
import { commitmentHistory, loadReceiptChain, submitReceipt } from "../../runtime/lib/commitment";
import { createGoal } from "../../runtime/lib/goals";
import { createTask } from "../../runtime/lib/tasks";
import { RunPaths } from "../../runtime/lib/paths";
import { scan } from "../../runtime/lib/wait";
import { claimTestWork } from "./helpers";

const dirs: string[] = [];
const ENV_KEYS = [
	"CODEFLOW_RUN_ID", "CODEFLOW_RUNS_DIR", "CODEFLOW_GOAL_ID", "CODEFLOW_EXECUTION_ID",
	"CODEFLOW_COMMITMENT_ID", "CODEFLOW_PARENT_COMMITMENT_ID", "CODEFLOW_PROCESS_KIND",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	for (const key of ENV_KEYS) {
		const value = originalEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function runtime(kind: "root" | "worker" = "worker") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-collaborate-"));
	dirs.push(root);
	const paths = new RunPaths(path.join(root, "runs"), "task-collaborate");
	createTask(paths, "collaborate safely");
	process.env.CODEFLOW_RUN_ID = paths.runId;
	process.env.CODEFLOW_RUNS_DIR = paths.code;
	process.env.CODEFLOW_GOAL_ID = paths.runId;
	process.env.CODEFLOW_EXECUTION_ID = `exec-${kind}`;
	process.env.CODEFLOW_PROCESS_KIND = kind;
	delete process.env.CODEFLOW_COMMITMENT_ID;
	delete process.env.CODEFLOW_PARENT_COMMITMENT_ID;
	let tool: any;
	organization({ registerTool(value: unknown) { tool = value; } } as never);
	return { paths, root, tool };
}

async function execute(tool: any, action: Record<string, unknown>, cwd: string) {
	const input = { action };
	if (!Value.Check(tool.parameters, input)) throw new Error("test supplied an invalid collaborate action");
	return tool.execute("call", input, undefined, undefined, { cwd });
}

function body(result: any): any {
	return JSON.parse(result.content[0].text);
}

describe("minimal collaborate protocol", () => {
	test("Root and Worker receive one tool with depth-scoped actions", () => {
		const root = runtime("root");
		const rootActions = root.tool.parameters.properties.action.anyOf.map((entry: any) => entry.properties.name.const);
		expect(rootActions).toEqual(["inspect", "claim", "report", "delegate", "wait"]);

		const worker = runtime("worker");
		const workerActions = worker.tool.parameters.properties.action.anyOf.map((entry: any) => entry.properties.name.const);
		expect(workerActions).toEqual(["inspect", "claim", "report"]);
		expect(worker.tool.description).not.toContain("delegate");
		expect(worker.tool.promptSnippet).toBeUndefined();
		expect(worker.tool.promptGuidelines).toBeUndefined();
	});

	test("schema locks the small claim and report surfaces", () => {
		const { tool } = runtime("root");
		const variants = tool.parameters.properties.action.anyOf as any[];
		const byName = new Map(variants.map((variant) => [variant.properties.name.const, variant]));
		expect(Object.keys(byName.get("inspect").properties)).toEqual(["name", "goal_id", "commitment_id", "receipt_id"]);
		expect(Object.keys(byName.get("claim").properties)).toEqual(["name", "work", "done_when", "constraints"]);
		expect(byName.get("claim").required).toEqual(["name", "work"]);
		expect(Object.keys(byName.get("report").properties)).toEqual(["name", "status", "summary", "effects", "remaining"]);
		expect(byName.get("report").required).toEqual(["name", "status", "summary"]);
		expect(Object.keys(byName.get("delegate").properties)).toEqual(["name", "goal_id", "new_goal", "focus", "resume_commitment_id"]);
		expect(byName.get("delegate").properties.focus.maxLength).toBeUndefined();
		expect(Value.Check(tool.parameters, {
			action: { name: "delegate", goal_id: "task-a", focus: "inspect one outcome" },
		})).toBe(true);
		expect(Value.Check(tool.parameters, {
			action: { name: "delegate", goal_id: "task-a", focus: "x".repeat(1_200) },
		})).toBe(true);
		expect(Value.Check(tool.parameters, {
			action: {
				name: "delegate",
				new_goal: { goal_id: "child", objective: "deliver a distinct outcome" },
				focus: "inspect the new outcome",
			},
		})).toBe(true);
		expect(Value.Check(tool.parameters, {
			action: {
				name: "delegate",
				goal: { existing: "task-a" },
				focus: "legacy nested syntax",
			},
		})).toBe(false);
		expect(Value.Check(tool.parameters, {
			action: {
				name: "delegate",
				goal_id: "task-a",
				objective: "ambiguous legacy create signal",
				focus: "legacy objective syntax",
			},
		})).toBe(false);
		expect(JSON.stringify(tool.parameters)).not.toMatch(/claim_revision|invariant|falsification|obligation|decomposition|resolved|partial|superseded/);
		expect(Value.Check(tool.parameters, { action: { name: "claim", work: "bounded work" } })).toBe(true);
		expect(Value.Check(tool.parameters, { action: { name: "claim" } })).toBe(false);
	});

	test("a Worker claims, reports progress, and completes", async () => {
		const { paths, root, tool } = runtime("worker");
		const inspected = body(await execute(tool, { name: "inspect" }, root));
		expect(inspected.goal.goal_id).toBe(paths.runId);
		const claimed = body(await execute(tool, {
			name: "claim",
			work: "repair the parser",
			done_when: ["the regression passes"],
		}, root));
		await execute(tool, {
			name: "report",
			status: "progress",
			summary: "isolated the failing branch",
			remaining: ["apply and verify the repair"],
		}, root);
		const receipt = body(await execute(tool, {
			name: "report",
			status: "completed",
			summary: "parser repaired and verified",
			effects: [{ file: "src/parser.ts" }],
		}, root));
		expect(loadReceiptChain(paths, claimed.commitment_id).terminal?.id).toBe(receipt.receipt_id);
		const recalled = body(await execute(tool, { name: "inspect", receipt_id: receipt.receipt_id }, root));
		expect(recalled.commitment.id).toBe(claimed.commitment_id);
		expect(recalled.receipt).toMatchObject({ id: receipt.receipt_id, summary: "parser repaired and verified" });
		await expect(execute(tool, {
			name: "inspect",
			commitment_id: claimed.commitment_id,
			receipt_id: receipt.receipt_id,
		}, root)).rejects.toThrow(/at most one/);
	});

	test("pre-claim blockers use report and prevent a fabricated claim", async () => {
		const { paths, root, tool } = runtime("worker");
		const report = body(await execute(tool, {
			name: "report",
			status: "blocked",
			summary: "the requested outcome needs a different Goal",
			remaining: ["Root must revise the Goal boundary"],
		}, root));
		expect(report.execution_id).toBe("exec-worker");
		expect(scan(paths.events, 0, ["worker_reported"]).events).toHaveLength(1);
		await expect(execute(tool, { name: "claim", work: "fabricated work" }, root)).rejects.toThrow(/reported a blocker/);
	});

	test("Root needs an open Commitment and a Child Commitment before closure", async () => {
		const { paths, root, tool } = runtime("root");
		await expect(execute(tool, {
			name: "delegate", goal_id: paths.runId, focus: "inspect one outcome",
		}, root)).rejects.toThrow(/claim its own Commitment first/);
		const claimed = body(await execute(tool, { name: "claim", work: "steward Task closure" }, root));
		await expect(execute(tool, {
			name: "report", status: "completed", summary: "all work integrated",
		}, root)).rejects.toThrow(/requires at least one Child Worker Commitment/);
		const child = claimTestWork(paths, {
			goalId: paths.runId,
			parentCommitmentId: claimed.commitment_id,
			work: "implement the delegated change",
		});
		await expect(execute(tool, {
			name: "report", status: "completed", summary: "too early",
		}, root)).rejects.toThrow(/every delegated Worker and Child Commitment to finish/);
		submitReceipt(paths, { commitmentId: child.id, status: "completed", summary: "change verified" });
		const receipt = body(await execute(tool, {
			name: "report", status: "completed", summary: "delegated result integrated",
		}, root));
		expect(receipt.status).toBe("completed");
	});

	test("a completed Goal can be delegated again without copying it", async () => {
		const { paths, root, tool } = runtime("worker");
		const first = body(await execute(tool, { name: "claim", work: "first pass" }, root));
		await execute(tool, { name: "report", status: "completed", summary: "first pass complete" }, root);
		delete process.env.CODEFLOW_COMMITMENT_ID;
		process.env.CODEFLOW_EXECUTION_ID = "exec-worker-2";
		let secondTool: any;
		organization({ registerTool(value: unknown) { secondTool = value; } } as never);
		const second = body(await execute(secondTool, { name: "claim", work: "follow-up from new evidence" }, root));
		expect(second.commitment_id).not.toBe(first.commitment_id);
		expect(commitmentHistory(paths).map((view) => view.commitment.goal_id)).toEqual([paths.runId, paths.runId]);
	});

	test("delegate explicitly reuses or creates a Goal without inferring from objective presence", async () => {
		const { paths, root, tool } = runtime("root");
		await execute(tool, { name: "claim", work: "coordinate dependent work" }, root);
		await expect(execute(tool, {
			name: "delegate",
			focus: "missing Goal selection",
		}, root)).rejects.toThrow(/exactly one of goal_id or new_goal/);
		await expect(execute(tool, {
			name: "delegate",
			goal_id: paths.runId,
			new_goal: { goal_id: "ambiguous", objective: "must not be created" },
			focus: "conflicting Goal selection",
		}, root)).rejects.toThrow(/exactly one of goal_id or new_goal/);
		expect(fs.existsSync(paths.goalPath("ambiguous"))).toBe(false);
		createGoal(paths, { id: "dependency", objective: "finish dependency" });
		createGoal(paths, { id: "existing", objective: "existing outcome", dependencies: ["dependency"] });

		const reused = body(await execute(tool, {
			name: "delegate",
			goal_id: "existing",
			focus: "continue the existing outcome",
		}, root));
		expect(reused).toEqual({ goal_id: "existing", status: "waiting", execution_id: null });

		const created = body(await execute(tool, {
			name: "delegate",
			new_goal: {
				goal_id: "new-outcome",
				objective: "deliver a materially different outcome",
				dependencies: ["dependency"],
			},
			focus: "begin after the dependency",
		}, root));
		expect(created).toEqual({ goal_id: "new-outcome", status: "waiting", execution_id: null });
		expect(fs.existsSync(paths.goalPath("existing"))).toBe(true);
		expect(fs.existsSync(paths.goalPath("new-outcome"))).toBe(true);
	});

	test("child bootstrap carries Goal, focus, and lineage without a prewritten Commitment", () => {
		const env = buildChildEnvironment({}, "/tmp/project", {
			goalId: "child-goal",
			focus: "investigate the failing parser tests",
			parentCommitmentId: "c_parent",
		}, "exec-child");
		expect(env).toMatchObject({
			CODEFLOW_GOAL_ID: "child-goal",
			CODEFLOW_EXECUTION_ID: "exec-child",
			CODEFLOW_PARENT_COMMITMENT_ID: "c_parent",
			CODEFLOW_WORK_FOCUS: "investigate the failing parser tests",
			CODEFLOW_PROCESS_KIND: "worker",
		});
		expect(env.CODEFLOW_COMMITMENT_ID).toBeUndefined();
	});

	test("launch failure is attributed without inventing a Commitment", async () => {
		const { paths, root } = runtime("root");
		const outcome = await spawnWorker({
			goalId: paths.runId,
			focus: "bounded investigation",
			parentCommitmentId: "c_parent",
		}, undefined, root, {
			executionId: "exec-launch-failure",
			resolve() { throw new Error("missing provider config"); },
		});
		expect(outcome).toMatchObject({
			execution_id: "exec-launch-failure",
			commitment_id: null,
			status: "interrupted",
			runtime_failure_reasons: ["WORKER_LAUNCH_FAILURE"],
		});
		expect(commitmentHistory(paths)).toEqual([]);
	});

	test("delegate returns immediately and wait observes the eventual Worker result", async () => {
		const { paths, root } = runtime("root");
		const launch = delegateWorker({
			goalId: paths.runId,
			focus: "bounded work",
			parentCommitmentId: "c_parent",
		}, undefined, root, {
			executionId: "exec-async",
			resolve: () => ({
				provider: "test-provider",
				model: "test-model",
				systemPrompts: ["worker", "engineering"],
				promptPaths: ["/tmp/worker.md", "/tmp/engineering.md"],
			}),
			spawnProcess: (() => {
				const child = new EventEmitter() as any;
				child.pid = 222;
				child.stdout = new PassThrough();
				child.stderr = new PassThrough();
				child.exitCode = null;
				child.signalCode = null;
				child.kill = () => true;
				setTimeout(() => {
					child.exitCode = 0;
					child.emit("close", 0);
				}, 5);
				return child;
			}) as never,
		});
		expect(launch).toEqual({ execution_id: "exec-async", goal_id: paths.runId, status: "running" });
		expect(await waitForWorker("exec-async")).toMatchObject({
			execution_id: "exec-async",
			status: "interrupted",
			runtime_failure_reasons: ["COMMITMENT_CLAIM_MISSING"],
		});
	});

	test("wait yields on Claim and progress before a Worker terminates", async () => {
		const { paths, root } = runtime("root");
		const parent = claimTestWork(paths, {
			goalId: paths.runId,
			workerExecutionId: "exec-root-progress",
			work: "coordinate progress feedback",
		});
		let child: (EventEmitter & {
			pid: number;
			stdout: PassThrough;
			stderr: PassThrough;
			exitCode: number | null;
			signalCode: null;
			kill: () => boolean;
		}) | undefined;
		delegateWorker({
			goalId: paths.runId,
			focus: "bounded work with progress",
			parentCommitmentId: parent.id,
		}, undefined, root, {
			executionId: "exec-progress",
			resolve: () => ({
				provider: "test-provider",
				model: "test-model",
				systemPrompts: ["worker", "engineering"],
				promptPaths: ["/tmp/worker.md", "/tmp/engineering.md"],
			}),
			spawnProcess: (() => {
				child = new EventEmitter() as typeof child;
				child!.pid = 333;
				child!.stdout = new PassThrough();
				child!.stderr = new PassThrough();
				child!.exitCode = null;
				child!.signalCode = null;
				child!.kill = () => true;
				return child;
			}) as never,
		});
		const commitment = claimTestWork(paths, {
			goalId: paths.runId,
			parentCommitmentId: parent.id,
			workerExecutionId: "exec-progress",
			work: "implement with observable progress",
		});
		const progress = submitReceipt(paths, {
			commitmentId: commitment.id,
			status: "progress",
			summary: "implementation ready for feedback",
			remaining: ["finish verification"],
		});
		expect(await waitForWorker("exec-progress")).toEqual({
			execution_id: "exec-progress",
			goal_id: paths.runId,
			commitment_id: commitment.id,
			status: "running",
		});
		expect(await waitForWorker("exec-progress")).toEqual({
			execution_id: "exec-progress",
			goal_id: paths.runId,
			commitment_id: commitment.id,
			receipt_id: progress.id,
			status: "progress",
		});

		const terminal = submitReceipt(paths, {
			commitmentId: commitment.id,
			status: "completed",
			summary: "verification complete",
		});
		child!.exitCode = 0;
		child!.emit("close", 0);
		expect(await waitForWorker("exec-progress")).toMatchObject({
			execution_id: "exec-progress",
			receipt_id: terminal.id,
			status: "completed",
		});
	});
});
