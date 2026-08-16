import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GoalError } from "../../runtime/lib/goals";
import { finishHandoff, openHandoff } from "../../runtime/lib/handoff";
import { RunPaths } from "../../runtime/lib/paths";
import {
	reconcileHandoff,
	resolveGoalTask,
} from "../../runtime/extensions/codeflow-task/registry";
import { taskResolutionFailure } from "../../runtime/extensions/codeflow-task/index";

let project: string;
let paths: RunPaths;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-task-registry-"));
	process.chdir(project);
	paths = new RunPaths(".codeflow/runs/code", "run-task-registry-test");
	for (const key of ["CODEFLOW_RUN_ID", "CODEFLOW_RUNS_DIR", "CODEFLOW_HANDOFF_ID"]) {
		savedEnv[key] = process.env[key];
	}
	process.env.CODEFLOW_RUN_ID = paths.runId;
	process.env.CODEFLOW_RUNS_DIR = paths.code;
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
	test("resolves a goal lane, role contract, and persistent session id", () => {
		defineMovementGoal();
		const goal = resolveGoalTask("tester", "movement-r1", "test");
		expect(goal).toMatchObject({
			goalId: "movement-r1",
			lane: "test",
			sessionId: `${paths.runId}-movement-r1-test`,
		});
		expect(goal?.contract.lanes.test.role).toBe("tester");
	});

	test("rejects invalid lanes and lane ownership mismatches", () => {
		defineMovementGoal();
		expect(() => resolveGoalTask("tester", "movement-r1", "product")).toThrow("invalid goal lane: product");
		expect(() => resolveGoalTask("coder", "movement-r1", "test")).toThrow(
			"does not own goal movement-r1 lane test",
		);
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
		const details = { agent: "tester", exitCode: 1, stderr: "" };

		const result = taskResolutionFailure(
			new ReferenceError("secretInternalSymbol is not defined"),
			details,
		);

		expect(result.isError).toBe(true);
		expect(result.terminate).toBe(true);
		expect(result.content[0]?.text).toContain("Codeflow runtime failure");
		expect(result.content[0]?.text).not.toContain("secretInternalSymbol");
		const state = JSON.parse(
			fs.readFileSync(paths.statePath(root.handoff_id), "utf8"),
		) as { status: string; blocked?: { reasons?: string[] } };
		expect(state.status).toBe("blocked");
		expect(state.blocked?.reasons).toContain("PROVIDER_FAILURE");
	});

	test("expected goal-contract errors remain ordinary tool errors", () => {
		const result = taskResolutionFailure(new GoalError("invalid goal lane"), {
			agent: "tester",
			exitCode: 1,
			stderr: "",
		});
		expect(result.isError).toBe(true);
		expect(result.terminate).toBeUndefined();
		expect(result.content[0]?.text).toContain("invalid goal lane");
	});
});
