import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalJson, contentHash } from "../../runtime/lib/canonical";
import { commitmentHistory, loadCommitment, submitReceipt } from "../../runtime/lib/commitment";
import { createGoal, goalRecords, updateGoalDependencies } from "../../runtime/lib/goals";
import { RunPaths } from "../../runtime/lib/paths";
import { inspectGoal } from "../../runtime/lib/inspection";
import { goalState, taskState } from "../../runtime/lib/state";
import { createTask } from "../../runtime/lib/tasks";
import { claimTestWork } from "./helpers";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function runtime(): RunPaths {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-runtime-"));
	dirs.push(root);
	return new RunPaths(path.join(root, "runs"), "task-root");
}

describe("Goal and Commitment protocol", () => {
	test("the Task is the root Goal and Child Goals form an acyclic dependency graph", () => {
		const paths = runtime();
		const task = createTask(paths, "Complete the system");
		expect(task.id).toBe(paths.runId);
		createGoal(paths, { id: "contract", objective: "Establish contract" });
		createGoal(paths, { id: "implementation", objective: "Implement behavior", dependencies: ["contract"] });
		expect(() => updateGoalDependencies(paths, "contract", ["implementation"])).toThrow(/cycle/);
		expect(goalRecords(paths).map((goal) => goal.id)).toEqual(["contract", "implementation"]);
	});

	test("canonical identities and the shared sequence are stable", () => {
		const paths = runtime();
		createTask(paths, "Ship feature");
		expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
		expect(contentHash({ b: 2, a: 1 })).toBe(contentHash({ a: 1, b: 2 }));
		const first = claimTestWork(paths, { goalId: paths.runId, work: "first pass" });
		const receipt = submitReceipt(paths, {
			commitmentId: first.id,
			status: "completed",
			summary: "first pass complete",
			effects: [{ git: "abc123" }],
		});
		const second = claimTestWork(paths, { goalId: paths.runId, work: "follow-up" });
		expect([first.seq, receipt.seq, second.seq]).toEqual([1, 2, 3]);
		expect([first.claim_revision, second.claim_revision]).toEqual([1, 2]);
	});

	test("a Goal is one-to-many and can be claimed again after completion", () => {
		const paths = runtime();
		createTask(paths, "Ship feature");
		const first = claimTestWork(paths, { goalId: paths.runId, work: "initial implementation" });
		submitReceipt(paths, { commitmentId: first.id, status: "completed", summary: "initial work complete" });
		const second = claimTestWork(paths, { goalId: paths.runId, work: "verify new evidence" });
		expect(second.goal_id).toBe(first.goal_id);
		expect(commitmentHistory(paths)).toHaveLength(2);
		expect(goalState(paths, paths.runId).status).toBe("active");
	});

	test("a Child Worker can claim the same Goal while its parent Commitment is open", () => {
		const paths = runtime();
		createTask(paths, "Ship feature");
		const parent = claimTestWork(paths, { goalId: paths.runId, work: "coordinate delivery" });
		const child = claimTestWork(paths, {
			goalId: paths.runId,
			parentCommitmentId: parent.id,
			work: "implement the delegated change",
		});
		expect(child.parent_commitment_id).toBe(parent.id);
		expect(commitmentHistory(paths).map((view) => view.commitment.id)).toEqual([parent.id, child.id]);
		expect(Object.keys(goalState(paths, paths.runId))).not.toContain("runnable");
	});

	test("a completed contribution can leave work for another Commitment in the same Goal", () => {
		const paths = runtime();
		createTask(paths, "Ship feature");
		createGoal(paths, { id: "contract", objective: "Establish the contract" });
		createGoal(paths, { id: "implementation", objective: "Implement behavior", dependencies: ["contract"] });
		const first = claimTestWork(paths, { goalId: "contract", work: "Investigate the contract" });
		submitReceipt(paths, {
			commitmentId: first.id, status: "completed", summary: "Identified behavior; one consumer still needs checking",
			remaining: ["Check the second consumer"],
		});
		expect(commitmentHistory(paths)[0].status).toBe("completed");
		expect(goalState(paths, "contract")).toMatchObject({ status: "pending", remaining: ["Check the second consumer"] });
		expect(goalState(paths, "implementation").status).toBe("waiting");
		const next = claimTestWork(paths, { goalId: "contract", work: "Check the second consumer" });
		submitReceipt(paths, { commitmentId: next.id, status: "completed", summary: "Both consumers verified" });
		expect(goalState(paths, "contract")).toMatchObject({ status: "completed", remaining: [] });
		expect(goalState(paths, "implementation").status).toBe("pending");
	});

	test("only completed and blocked are terminal Receipt outcomes", () => {
		const paths = runtime();
		createTask(paths, "Ship feature");
		const completed = claimTestWork(paths, { goalId: paths.runId, work: "complete work" });
		submitReceipt(paths, { commitmentId: completed.id, status: "completed", summary: "done" });
		const blocked = claimTestWork(paths, { goalId: paths.runId, work: "blocked work" });
		submitReceipt(paths, {
			commitmentId: blocked.id,
			status: "blocked",
			summary: "external input missing",
			remaining: ["obtain the input"],
		});
		expect(() => submitReceipt(paths, {
			commitmentId: blocked.id,
			status: "progress",
			summary: "late report",
		})).toThrow(/already closed/);
	});

	test("tampering is rejected and inspection returns current Goal work", () => {
		const paths = runtime();
		createTask(paths, "Ship feature");
		const work = claimTestWork(paths, { goalId: paths.runId, work: "inspect me" });
		const file = paths.commitmentPath(work.id);
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		value.work = "tampered";
		fs.writeFileSync(file, JSON.stringify(value));
		expect(() => loadCommitment(paths, work.id)).toThrow(/content hash mismatch/);

		fs.rmSync(paths.runDir, { recursive: true, force: true });
		createTask(paths, "Ship feature");
		createGoal(paths, { id: "child", objective: "Deliver child" });
		const child = claimTestWork(paths, { goalId: "child", work: "child work" });
		submitReceipt(paths, {
			commitmentId: child.id,
			status: "blocked",
			summary: "needs input",
			remaining: ["provide input"],
		});
		expect(inspectGoal(paths, "child")).toMatchObject({
			goal: { goal_id: "child", status: "blocked", remaining: ["provide input"] },
			commitments: [{ commitment: { id: child.id }, latest: { summary: "needs input" } }],
		});
		expect(taskState(paths).goals[0].status).toBe("blocked");
	});
});
