import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGoal } from "../../runtime/lib/goals";
import { recordRuntimeFailure, submitReceipt } from "../../runtime/lib/commitment";
import { claimTestWork } from "./helpers";
import { scanCommitmentStates } from "../../runtime/lib/observability/commitment-state";
import { summarizeCommitmentStates } from "../../runtime/lib/observability/summary";
import { RunPaths } from "../../runtime/lib/paths";
import { createTask } from "../../runtime/lib/tasks";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

test("observability projects canonical Commitment, Receipt, and interruption state", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-observe-"));
	dirs.push(root);
	const runs = path.join(root, "runs");
	const paths = new RunPaths(runs, "task-observe");
	createTask(paths, "Observe work");
	createGoal(paths, { id: "child", objective: "Child outcome" });
	const completed = claimTestWork(paths, { goalId: paths.runId, work: "complete work" });
	submitReceipt(paths, { commitmentId: completed.id, status: "completed", summary: "done" });
	const interrupted = claimTestWork(paths, { goalId: "child", work: "try child work" });
	recordRuntimeFailure(paths, interrupted.id, ["PROVIDER_FAILURE"], "provider failed");
	const scan = scanCommitmentStates(runs);
	expect(scan.states.map((state) => state.status)).toEqual(["completed", "interrupted"]);
	expect(scan.states[0]).toMatchObject({ task_id: paths.runId, goal_id: paths.runId, worker_kind: "worker" });
	expect(scan.states[1].runtime_failure_reasons).toEqual(["PROVIDER_FAILURE"]);
	expect(summarizeCommitmentStates(scan.states, true)).toMatchObject({ total: 2, completed: 1, interrupted: 1 });
});
