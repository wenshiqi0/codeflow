import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalJson, contentHash } from "../../runtime/lib/canonical";
import { createGoal, goalRecords, updateGoalDependencies } from "../../runtime/lib/goals";
import { handoffHistory, loadHandoff, openHandoff, submitReceipt } from "../../runtime/lib/handoff";
import { RunPaths } from "../../runtime/lib/paths";
import { recallGoal } from "../../runtime/lib/recall";
import { goalState, taskState } from "../../runtime/lib/state";
import { createTask } from "../../runtime/lib/tasks";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function runtime(taskId = "task-root"): RunPaths {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-runtime-"));
	dirs.push(root);
	return new RunPaths(path.join(root, "runs"), taskId);
}

function handoff(paths: RunPaths, goalId = paths.runId, intent = "deliver outcome") {
	return openHandoff(paths, {
		goalId,
		digest: intent,
		intent,
		known: ["known fact"],
		references: [{ kind: "file", ref: "src/example.ts" }],
		constraints: ["preserve behavior"],
		expectedOutcome: ["observable outcome"],
		evidenceRequirement: ["focused test"],
	});
}

describe("Task and Goal Graph", () => {
	test("Task is the root Goal and no synthetic Goal is persisted", () => {
		const paths = runtime();
		const task = createTask(paths, "Complete the system", ["tests pass"]);
		expect(task.id).toBe(paths.runId);
		const root = handoff(paths);
		expect(root.goal_id).toBe(task.id);
		expect(goalRecords(paths)).toEqual([]);
		expect(fs.existsSync(paths.goalPath(task.id))).toBe(false);
	});

	test("child Goals form an acyclic result-dependency graph", () => {
		const paths = runtime();
		createTask(paths, "Ship feature");
		createGoal(paths, { id: "contract", objective: "Establish contract" });
		createGoal(paths, { id: "implementation", objective: "Implement behavior", dependencies: ["contract"] });
		expect(() => updateGoalDependencies(paths, "contract", ["implementation"])).toThrow(/cycle/);
		expect(goalRecords(paths).map((goal) => goal.id)).toEqual(["contract", "implementation"]);
	});
});

describe("immutable Handoff and Receipt protocol", () => {
	test("canonical serialization and identity are byte-stable", () => {
		expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
		expect(contentHash({ b: 2, a: 1 })).toBe(contentHash({ a: 1, b: 2 }));
	});

	test("Handoffs and Receipts share one monotonic semantic sequence", () => {
		const paths = runtime();
		createTask(paths, "Ship feature");
		const first = handoff(paths, paths.runId, "first");
		const receipt = submitReceipt(paths, {
			handoffId: first.id,
			status: "completed",
			effects: [{ git: "abc123" }, { file: "/tmp/result.json" }],
			established: ["first outcome holds"],
		});
		const second = handoff(paths, paths.runId, "second");
		expect([first.seq, receipt.seq, second.seq]).toEqual([1, 2, 3]);
		expect(receipt.id).toMatch(/^r_[0-9a-f]{64}$/);
		expect(first.id).toMatch(/^h_[0-9a-f]{64}$/);
		expect(() => submitReceipt(paths, { handoffId: first.id, status: "failed" })).toThrow(/already has a receipt/);
	});

	test("tampering is rejected and every semantic Receipt status is supported", () => {
		const paths = runtime();
		createTask(paths, "Ship feature");
		for (const status of ["completed", "partial", "blocked", "failed", "superseded"] as const) {
			const opened = handoff(paths, paths.runId, status);
			submitReceipt(paths, {
				handoffId: opened.id,
				status,
				blockers: status === "blocked" ? ["external dependency"] : [],
			});
		}
		const target = handoffHistory(paths)[0].handoff;
		const file = paths.handoffPath(target.id);
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		value.intent = "tampered";
		fs.writeFileSync(file, JSON.stringify(value));
		expect(() => loadHandoff(paths, target.id)).toThrow(/content hash mismatch/);
	});
});

describe("state reduction and Recall", () => {
	test("reduces Root and child state from Receipts", () => {
		const paths = runtime();
		createTask(paths, "Ship feature");
		const root = handoff(paths);
		submitReceipt(paths, { handoffId: root.id, status: "completed", established: ["scope fixed"] });
		createGoal(paths, { id: "child", objective: "Deliver child" });
		const child = handoff(paths, "child", "child work");
		submitReceipt(paths, { handoffId: child.id, status: "blocked", blockers: ["needs input"] });
		expect(goalState(paths, paths.runId).established).toEqual(["scope fixed"]);
		expect(goalState(paths, "child").status).toBe("blocked");
		expect(taskState(paths).status).toBe("partial");
		expect(recallGoal(paths, "child", "semantic")).toMatchObject({
			level: "semantic",
			goal_id: "child",
			history: [{ kind: "handoff" }, { kind: "receipt", status: "blocked" }],
		});
	});
});
