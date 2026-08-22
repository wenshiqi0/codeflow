import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defineGoal } from "../../runtime/lib/goals";
import { finishHandoff, openHandoff } from "../../runtime/lib/handoff";
import { RunPaths } from "../../runtime/lib/paths";

let project: string;
let paths: RunPaths;

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-root-closure-"));
	process.chdir(project);
	paths = new RunPaths(".codeflow/runs/code", "run-root-closure");
});

afterEach(() => {
	const cwd = process.cwd();
	process.chdir(path.dirname(cwd));
	fs.rmSync(project, { recursive: true, force: true });
});

function root() {
	return openHandoff(paths, {
		role: "worker",
		depth: 0,
		body: "Goal: deliver the observable product outcome\n",
	});
}

function receipt(name: string, status: "PASS" | "FAIL" = "PASS") {
	fs.writeFileSync(name, JSON.stringify({ status }), "utf8");
	return name;
}

function closure() {
	fs.writeFileSync("closure.md", "closure\n", "utf8");
	return "closure.md";
}

describe("root closure", () => {
	test("root PASS requires a JSON receipt and closure artifact without a goal join", () => {
		const handoff = root();
		defineGoal(paths, { id: "product-r1", goal: "Deliver outcome" });
		expect(() =>
			finishHandoff(paths, {
				handoffId: handoff.handoff_id,
				status: "PASS",
				summary: "done",
				receipt: receipt("root.json"),
			}),
		).toThrow("requires a non-empty closure artifact");
		expect(() =>
			finishHandoff(paths, {
				handoffId: handoff.handoff_id,
				status: "PASS",
				summary: "done",
				artifacts: [closure()],
			}),
		).toThrow("requires a non-empty JSON receipt");
		expect(
			finishHandoff(paths, {
				handoffId: handoff.handoff_id,
				status: "PASS",
				summary: "done",
				receipt: receipt("root.json"),
				artifacts: [closure()],
			}).status,
		).toBe("PASS");
	});

	test("a zero-goal solo root has the same PASS requirements", () => {
		const handoff = root();
		expect(
			finishHandoff(paths, {
				handoffId: handoff.handoff_id,
				status: "PASS",
				summary: "solo done",
				receipt: receipt("solo.json"),
				artifacts: [closure()],
			}).status,
		).toBe("PASS");
	});

	test("a goal need not satisfy any mechanical join", () => {
		const handoff = root();
		defineGoal(paths, { id: "product-r1", goal: "No grouped handoff has run" });
		expect(
			finishHandoff(paths, {
				handoffId: handoff.handoff_id,
				status: "PASS",
				summary: "root states goal ownership",
				receipt: receipt("owned.json"),
				artifacts: [closure()],
			}).status,
		).toBe("PASS");
	});
});
