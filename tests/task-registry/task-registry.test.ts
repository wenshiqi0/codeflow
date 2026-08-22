import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GoalError } from "../../runtime/lib/goals";
import { finishHandoff, openHandoff } from "../../runtime/lib/handoff";
import { RunPaths } from "../../runtime/lib/paths";
import {
	assertThreadAvailable,
	reconcileHandoff,
	resolveGoalTask,
} from "../../runtime/extensions/codeflow-task/registry";
import {
	assertTaskPrompt,
	childHandoffPrompt,
	MAX_CONCURRENCY,
	MAX_TASK_PROMPT_CHARS,
	taskResolutionFailure,
} from "../../runtime/extensions/codeflow-task/index";

let project: string;
let paths: RunPaths;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-task-registry-"));
	process.chdir(project);
	paths = new RunPaths(".codeflow/runs/code", "run-task-registry-test");
	for (const key of [
		"CODEFLOW_RUN_ID",
		"CODEFLOW_RUNS_DIR",
		"CODEFLOW_HANDOFF_ID",
		"CODEFLOW_AGENT_ROLE",
		"CODEFLOW_AGENT_DEPTH",
	]) {
		savedEnv[key] = process.env[key];
	}
	process.env.CODEFLOW_RUN_ID = paths.runId;
	process.env.CODEFLOW_RUNS_DIR = paths.code;
	process.env.CODEFLOW_AGENT_ROLE = "planner";
	process.env.CODEFLOW_AGENT_DEPTH = "0";
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	const cwd = process.cwd();
	process.chdir(path.dirname(cwd));
	fs.rmSync(project, { recursive: true, force: true });
});

function defineMovementGoal() {
	return defineGoal(paths, {
		id: "movement-r1",
		goal: "Deterministic movement",
		definitionOfDone: ["Business tests pass"],
	});
}

// Import after the environment helpers to keep the test file readable.
import { defineGoal } from "../../runtime/lib/goals";

describe("task registry", () => {
	test("keeps handoffs concise before opening a child", () => {
		expect(() => assertTaskPrompt("   ")).toThrow("task prompt must not be empty");
		expect(() => assertTaskPrompt("x".repeat(MAX_TASK_PROMPT_CHARS + 1))).toThrow(
			`task prompt exceeds ${MAX_TASK_PROMPT_CHARS} characters`,
		);
		expect(() => assertTaskPrompt("Outcome: bounded behavior")).not.toThrow();
	});

	test("exports one task-group concurrency ceiling", () => {
		expect(MAX_CONCURRENCY).toBe(8);
	});

	test("resolves a goal thread and persistent session id", () => {
		defineMovementGoal();
		const goal = resolveGoalTask("tester", "movement-r1", "implementation");
		expect(goal).toMatchObject({
			goalId: "movement-r1",
			thread: "implementation",
			sessionId: `${paths.runId}-movement-r1-implementation`,
			contract: { id: "movement-r1" },
		});
	});

	test("thread continuations receive a bounded body pointer; fresh threads do not", () => {
		defineMovementGoal();
		const goal = resolveGoalTask("coder", "movement-r1", "implementation");
		const full = "Outcome: implement movement\nIntent: preserve behavior\n";
		const first = openHandoff(paths, {
			role: "coder",
			depth: 1,
			body: full,
			goalId: goal.goalId,
			thread: goal.thread,
		});
		expect(childHandoffPrompt(full, first.handoff_id, goal)).toBe(full);
		finishHandoff(paths, {
			handoffId: first.handoff_id,
			status: "BLOCKED",
			blockedReasons: ["EXECUTION_TIMEOUT"],
			summary: "split needed",
		});

		const second = openHandoff(paths, {
			role: "coder",
			depth: 1,
			body: full,
			goalId: goal.goalId,
			thread: goal.thread,
		});
		const pointer = childHandoffPrompt(full, second.handoff_id, goal);
		expect(pointer).toContain(
			`handoff ${second.handoff_id} opened for goal movement-r1 thread implementation:`,
		);
		expect(pointer).toContain(`code-agent handoff body --id ${second.handoff_id}`);
		expect(pointer.length).toBeLessThan(400);
		expect(childHandoffPrompt(full, second.handoff_id, null)).toBe(full);
	});

	test("an omitted goal is ungrouped and an omitted thread is fresh", () => {
		const first = resolveGoalTask("tester", undefined, undefined);
		const second = resolveGoalTask("tester", undefined, undefined);
		expect(first).toMatchObject({ goalId: "_ungrouped", contract: null });
		expect(second.thread).not.toBe(first.thread);
		expect(first.sessionId).toContain(`${paths.runId}-_ungrouped-`);
	});

	test("rejects invalid threads and refuses concurrent same-goal-thread work", () => {
		defineMovementGoal();
		expect(() => resolveGoalTask("tester", "movement-r1", "Invalid Thread")).toThrow(
			"invalid task thread",
		);
		const goal = resolveGoalTask("tester", "movement-r1", "implementation");
		expect(() => assertThreadAvailable(goal)).not.toThrow();
		openHandoff(paths, {
			role: "tester",
			depth: 1,
			body: "Goal: active work\n",
			goalId: goal.goalId,
			thread: goal.thread,
		});
		expect(() => assertThreadAvailable(goal)).toThrow(
			"thread implementation already has active handoff",
		);
	});

	test("the task tool throws contract failures so Pi records isError true", async () => {
		defineMovementGoal();
		const registered = new Map<string, any>();
		const mod = await import("../../runtime/extensions/codeflow-task/index.ts");
		mod.default({
			registerTool: (tool: { name: string }) => registered.set(tool.name, tool),
		} as never);
		const task = registered.get("task");
		expect(task).toBeDefined();
		await expect(
			task.execute(
				"tool-call",
				{
					agent: "tester",
					prompt: "decide a boundary",
					goal_id: "movement-r1",
					thread: "Invalid Thread",
				},
				undefined,
				undefined,
				{ cwd: project },
			),
		).rejects.toThrow("invalid task thread");
	});

	test("reconciles a successful child without losing the watchdog marker import", () => {
		const opened = openHandoff(paths, {
			role: "architect",
			body: "Goal: decide\n",
			depth: 1,
		});
		const receipt = "receipt.json";
		fs.writeFileSync(receipt, JSON.stringify({ status: "PASS" }));
		finishHandoff(paths, {
			handoffId: opened.handoff_id,
			status: "PASS",
			summary: "decision complete",
			receipt,
			artifacts: [],
		});

		const result = reconcileHandoff(
			{
				handoffId: opened.handoff_id,
				statePath: paths.statePath(opened.handoff_id),
				receiptPath: paths.receiptPath(opened.handoff_id),
			},
			{
				agent: "architect",
				success: true,
				content: "done",
				exitCode: 0,
				stderr: "",
			},
			project,
		);

		expect(result).toMatchObject({ status: "PASS", reasons: [] });
	});

	test("unexpected resolution failures block the root without leaking internals", () => {
		const root = openHandoff(paths, {
			role: "planner",
			body: "Goal: coordinate\n",
			depth: 0,
		});
		process.env.CODEFLOW_HANDOFF_ID = root.handoff_id;

		expect(() =>
			taskResolutionFailure(new ReferenceError("secretInternalSymbol is not defined")),
		).toThrow("Codeflow runtime failure");
		const state = JSON.parse(
			fs.readFileSync(paths.statePath(root.handoff_id), "utf8"),
		) as { status: string; blocked?: { reasons?: string[] } };
		expect(state.status).toBe("blocked");
		expect(state.blocked?.reasons).toContain("PROVIDER_FAILURE");
	});

	test("expected goal-contract errors remain ordinary tool errors", () => {
		expect(() => taskResolutionFailure(new GoalError("invalid goal lane"))).toThrow(
			"invalid goal lane",
		);
	});
});
