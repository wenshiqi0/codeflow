import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertRootPassGoalJoins } from "../../runtime/cli/handoff";
import { defineGoal } from "../../runtime/lib/goals";
import { finishHandoff, openHandoff } from "../../runtime/lib/handoff";
import { RunPaths } from "../../runtime/lib/paths";

let project: string;
let paths: RunPaths;

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-root-goal-gate-"));
	process.chdir(project);
	paths = new RunPaths(".codeflow/runs/code", "run-root-goal-gate");
});

afterEach(() => {
	const cwd = process.cwd();
	process.chdir(path.dirname(cwd));
	fs.rmSync(project, { recursive: true, force: true });
});

function prepareRun() {
	const root = openHandoff(paths, {
		role: "planner",
		depth: 0,
		body: "Goal: deliver the observable product outcome\n",
	});
	defineGoal(paths, {
		id: "product-r1",
		goal: "Deliver the observable product outcome",
		definitionOfDone: ["All lanes pass"],
	});
	return root;
}

function passLane(lane: "code" | "test" | "verify", index: number) {
	const handoff = openHandoff(paths, {
		role: lane === "code" ? "coder" : lane === "test" ? "tester" : "verify",
		body: `Goal: complete ${lane}\n`,
		depth: 1,
		goalId: "product-r1",
		lane,
	});
	const receipt = `${lane}-${index}-receipt.json`;
	fs.writeFileSync(
		receipt,
		JSON.stringify({
			status: "PASS",
			...(lane === "verify" ? { command: "cargo test", exit_code: 0 } : {}),
		}),
		"utf8",
	);
	finishHandoff(paths, {
		handoffId: handoff.handoff_id,
		status: "PASS",
		receipt,
		summary: `${lane} pass`,
	});
}

describe("root goal gate", () => {
	test("rejects a root PASS while a goal join is unsatisfied", () => {
		const root = prepareRun();
		passLane("code", 1);
		expect(() => assertRootPassGoalJoins(paths, root.handoff_id)).toThrow(
			"root PASS requires every goal join to be satisfied: product-r1: test: latest handoff PASS; product-r1: verify: latest handoff PASS",
		);
	});

	test("allows a root PASS after every goal join is satisfied", () => {
		const root = prepareRun();
		for (const lane of ["code", "test", "verify"] as const) passLane(lane, 1);
		expect(() => assertRootPassGoalJoins(paths, root.handoff_id)).not.toThrow();
	});

	test("ignores delegated handoffs", () => {
		const delegated = openHandoff(paths, {
			role: "coder",
			body: "Goal: independent child work\n",
			depth: 1,
		});
		defineGoal(paths, { id: "unused-r1", goal: "No lane has run" });
		expect(() => assertRootPassGoalJoins(paths, delegated.handoff_id)).not.toThrow();
	});
});
