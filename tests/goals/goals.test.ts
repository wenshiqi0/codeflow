import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	defineGoal,
	goalSessionId,
	goalView,
	goalViews,
	loadGoal,
	THREAD_PATTERN,
} from "../../runtime/lib/goals";
import { finishHandoff, openHandoff } from "../../runtime/lib/handoff";
import { readJson, RunPaths } from "../../runtime/lib/paths";

let project: string;
let paths: RunPaths;

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-goals-"));
	process.chdir(project);
	paths = new RunPaths(".codeflow/runs/code", "run-goals-test");
});

afterEach(() => {
	const cwd = process.cwd();
	process.chdir(path.dirname(cwd));
	fs.rmSync(project, { recursive: true, force: true });
});

function defineMovementGoal() {
	return defineGoal(paths, {
		id: "movement-r1",
		goal: "Deterministic player movement",
		definitionOfDone: ["Movement business tests pass"],
	});
}

function openThreadHandoff(thread: string, status: "PASS" | "FAIL" = "PASS") {
	const opened = openHandoff(paths, {
		role: "worker",
		body: `Goal: work in ${thread}\n`,
		depth: 1,
		goalId: "movement-r1",
		thread,
	});
	const receipt = `${thread}-${status}-receipt.json`;
	fs.writeFileSync(receipt, JSON.stringify({ status }), "utf8");
	finishHandoff(paths, {
		handoffId: opened.handoff_id,
		status,
		receipt,
		summary: `${thread} ${status}`,
	});
	return opened;
}

describe("goal grouping contracts", () => {
	test("writes an immutable lane-free contract", () => {
		const result = defineMovementGoal();
		expect(result.goal_id).toBe("movement-r1");
		const contract = readJson<Record<string, unknown>>(paths.goalContractPath("movement-r1"));
		expect(Object.keys(contract)).toEqual([
			"schema_version",
			"id",
			"goal",
			"definition_of_done",
			"created_at",
		]);
		expect(contract.status).toBeUndefined();
		expect(contract.lanes).toBeUndefined();
	});

	test("rejects changing an existing contract", () => {
		defineMovementGoal();
		expect(() =>
			defineGoal(paths, { id: "movement-r1", goal: "A different goal" }),
		).toThrow("already exists with different content");
	});

	test("rejects retired lane contracts loudly", () => {
		defineMovementGoal();
		const file = paths.goalContractPath("movement-r1");
		const contract = readJson<Record<string, unknown>>(file);
		contract.lanes = { test: { role: "tester" } };
		fs.writeFileSync(file, JSON.stringify(contract));
		expect(() => loadGoal(paths, "movement-r1")).toThrow("uses the retired lane schema");
	});

	test("derives only statistics from grouped handoffs", () => {
		defineMovementGoal();
		openThreadHandoff("implementation");
		openThreadHandoff("implementation", "FAIL");
		openThreadHandoff("review");
		const view = goalView(paths, loadGoal(paths, "movement-r1"));
		expect(view).toMatchObject({
			goal_id: "movement-r1",
			handoff_count: 3,
			pass_count: 2,
			fail_count: 1,
			blocked_count: 0,
		});
		expect(view.threads.implementation).toEqual({
			handoff_count: 2,
			open_count: 0,
			pass_count: 1,
			fail_count: 1,
			blocked_count: 0,
		});
		expect(view.threads.review.handoff_count).toBe(1);
		expect("join" in view).toBe(false);
	});

	test("derives a stable session id for each goal thread", () => {
		expect(goalSessionId("run-x", "Movement R1", "implementation")).toBe(
			"run-x-movement-r1-implementation",
		);
		expect(() => goalSessionId("run-x", "movement-r1", "Invalid Thread")).toThrow(
			"invalid goal session thread",
		);
		expect(THREAD_PATTERN.test("a-1")).toBe(true);
	});

	test("goal list contains only grouping contracts", () => {
		expect(goalViews(paths)).toEqual([]);
		defineMovementGoal();
		expect(goalViews(paths)).toHaveLength(1);
	});
});
