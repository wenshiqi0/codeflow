import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordRuntimeFailure, submitReceipt } from "../../runtime/lib/commitment";
import { projectCommitmentState, readCommitmentStateProjections } from "../../runtime/lib/observability/commitment-state";
import { summarizeCommitmentStates } from "../../runtime/lib/observability/summary";
import { RunPaths, writeJsonAtomic } from "../../runtime/lib/paths";
import { createTask } from "../../runtime/lib/tasks";
import { claimTestWork } from "./helpers";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function runtime(): RunPaths {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-topology-"));
	dirs.push(root);
	const paths = new RunPaths(path.join(root, "runs"), "task-topology");
	createTask(paths, "observe actual collaboration");
	return paths;
}

test("observability derives lifecycle and delegation from runtime state", () => {
	const paths = runtime();
	const root = claimTestWork(paths, { goalId: paths.runId, work: "steward closure" });
	const child = claimTestWork(paths, {
		goalId: paths.runId,
		parentCommitmentId: root.id,
		work: "implement change",
	});
	submitReceipt(paths, { commitmentId: child.id, status: "completed", summary: "change verified" });
	const rootState = projectCommitmentState(paths, root.id);
	const childState = projectCommitmentState(paths, child.id);
	expect(rootState).toMatchObject({ status: "running", has_direct_child: true });
	expect(childState).toMatchObject({ status: "completed", has_direct_child: false });
	expect(rootState).not.toHaveProperty("decomposition");
	expect(rootState).not.toHaveProperty("obligation_regression");
	expect(summarizeCommitmentStates([rootState, childState], true)).toMatchObject({
		total: 2,
		running: 1,
		completed: 1,
		delegating: 1,
	});
});

test("interruption remains a runtime event rather than a Receipt", () => {
	const paths = runtime();
	const work = claimTestWork(paths, { goalId: paths.runId, work: "attempt work" });
	recordRuntimeFailure(paths, work.id, ["PROVIDER_FAILURE"], "provider failed");
	expect(projectCommitmentState(paths, work.id)).toMatchObject({
		status: "interrupted",
		receipt_id: null,
		runtime_failure_reasons: ["PROVIDER_FAILURE"],
	});
});

test("projection reader rejects removed declaration fields", () => {
	const paths = runtime();
	const file = path.join(paths.runDir, "projection.json");
	writeJsonAtomic(file, {
		schema_version: 1,
		states: [{
			schema_version: 1,
			task_id: paths.runId,
			commitment_id: "c_test",
			goal_id: paths.runId,
			parent_commitment_id: null,
			worker_kind: "worker",
			status: "open",
			receipt_id: null,
			runtime_failure_reasons: [],
			unknown_runtime_failure_reasons: 0,
			has_direct_child: false,
			decomposition: "split",
		}],
	});
	expect(() => readCommitmentStateProjections(file)).toThrow(/unexpected key decomposition/);
});
