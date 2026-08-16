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

function openLaneHandoff(lane: "test" | "code" | "verify") {
	return openHandoff(paths, {
		role: lane === "test" ? "tester" : lane === "code" ? "coder" : "verify",
		body: `Goal: complete ${lane}\n`,
		depth: 1,
		goalId: "movement-r1",
		lane,
	});
}

function receipt(
	name: string,
	status: "PASS" | "FAIL",
	lane: "test" | "code" | "verify",
): string {
	fs.writeFileSync(
		name,
		JSON.stringify({
			status,
			...(lane === "verify" ? { command: "npm test", exit_code: status === "PASS" ? 0 : 1 } : {}),
		}),
		"utf8",
	);
	return name;
}

describe("agent goals", () => {
	test("writes an immutable contract without status fields", () => {
		const result = defineMovementGoal();
		expect(result.goal_id).toBe("movement-r1");
		const contract = readJson<Record<string, unknown>>(paths.goalContractPath("movement-r1"));
		expect(Object.keys(contract)).toEqual([
			"schema_version",
			"id",
			"goal",
			"definition_of_done",
			"created_at",
			"lanes",
		]);
		expect(contract.status).toBeUndefined();
		expect(contract.result).toBeUndefined();
	});

	test("rejects changing an existing contract", () => {
		defineMovementGoal();
		expect(() =>
			defineGoal(paths, {
				id: "movement-r1",
				goal: "A different goal",
			}),
		).toThrow("already exists with different content");
	});

	test("records lane ownership without mechanical write roots", () => {
		defineMovementGoal();
		const contract = readJson<Record<string, any>>(paths.goalContractPath("movement-r1"));
		expect(contract.lanes).toEqual({
			test: { role: "tester" },
			code: { role: "coder" },
			verify: { role: "verify" },
		});
	});

	test("derives join satisfaction from handoffs", () => {
		defineMovementGoal();
		const handoffs = {
			test: openLaneHandoff("test"),
			code: openLaneHandoff("code"),
			verify: openLaneHandoff("verify"),
		};
		for (const lane of ["test", "code", "verify"] as const) {
			finishHandoff(paths, {
				handoffId: handoffs[lane].handoff_id,
				status: "PASS",
				receipt: receipt(`${lane}-receipt.json`, "PASS", lane),
				summary: `${lane} complete`,
			});
		}
		const view = goalView(paths, loadGoal(paths, "movement-r1"));
		expect(view.join.satisfied).toBe(true);
		expect(view.join.unsatisfied).toEqual([]);
		expect(view.lanes.test.latest_handoff?.result).toBe("PASS");
	});

	test("derives a stable session id for each goal lane", () => {
		expect(goalSessionId("run-x", "Movement R1", "code")).toBe(
			"run-x-movement-r1-code",
		);
		expect(() => goalSessionId("run-x", "movement-r1", "product")).toThrow(
			"invalid goal lane",
		);
	});

	test("a failed latest lane leaves the join unsatisfied", () => {
		defineMovementGoal();
		const testHandoff = openLaneHandoff("test");
		finishHandoff(paths, {
			handoffId: testHandoff.handoff_id,
			status: "FAIL",
			receipt: receipt("test-receipt.json", "FAIL", "test"),
			summary: "not red",
		});
		const [view] = goalViews(paths);
		expect(view.join.satisfied).toBe(false);
		expect(view.join.unsatisfied).toContain("test: latest handoff PASS");
	});
});
