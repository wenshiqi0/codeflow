import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGoal } from "../../runtime/lib/goals";
import { openHandoff, recordRuntimeFailure, submitReceipt } from "../../runtime/lib/handoff";
import { scanHandoffStates } from "../../runtime/lib/observability/handoff-state";
import { summarizeHandoffStates } from "../../runtime/lib/observability/summary";
import { validateAttemptUsageRecord } from "../../runtime/lib/observability/model-usage";
import { validateToolCallRecord } from "../../runtime/lib/observability/tool-execution";
import { RunPaths } from "../../runtime/lib/paths";
import { createTask } from "../../runtime/lib/tasks";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

test("observability projects canonical Handoff, Receipt, and interruption state", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-observe-"));
	dirs.push(root);
	const runs = path.join(root, "runs");
	const paths = new RunPaths(runs, "task-observe");
	createTask(paths, "Observe work");
	createGoal(paths, { id: "child", objective: "Child outcome" });
	const completed = openHandoff(paths, { goalId: paths.runId, digest: "done", intent: "do", expectedOutcome: ["done"] });
	submitReceipt(paths, { handoffId: completed.id, status: "completed", established: ["done"] });
	const interrupted = openHandoff(paths, { goalId: "child", digest: "try", intent: "try", expectedOutcome: ["done"] });
	recordRuntimeFailure(paths, interrupted.id, ["PROVIDER_FAILURE"], "provider failed");
	const scan = scanHandoffStates(runs);
	expect(scan.states.map((state) => state.status)).toEqual(["completed", "interrupted"]);
	expect(scan.states[0]).toMatchObject({ task_id: paths.runId, goal_id: paths.runId, worker_kind: "worker" });
	expect(scan.states[1].runtime_failure_reasons).toEqual(["PROVIDER_FAILURE"]);
	expect(summarizeHandoffStates(scan.states, true)).toMatchObject({ total: 2, completed: 1, interrupted: 1 });
});

test("usage and tool telemetry reject removed identity dimensions", () => {
	const usage = {
		schema_version: 1,
		at: new Date(0).toISOString(),
		request_started_at: null,
		attempt: 1,
		task_id: "task-a",
		worker_kind: "worker",
		provider: "provider",
		model: "model",
		turn: 1,
		handoff_id: "h_1",
		goal_id: "task-a",
		usage: { input: 1, output: 1, reasoning: 0, cache_read: 0, cache_write: 0, total_tokens: 2, cost: null },
	};
	expect(validateAttemptUsageRecord(usage)).toEqual([]);
	expect(validateAttemptUsageRecord({ ...usage, role: "planner" })).toContainEqual(expect.stringContaining("unexpected key: role"));
	const tool = {
		schema_version: 1,
		kind: "requested",
		call_id: "call-1",
		tool: "read",
		status: null,
		at: new Date(0).toISOString(),
		task_id: "task-a",
		worker_kind: "worker",
		handoff_id: "h_1",
		goal_id: "task-a",
		provider: "provider",
		model: "model",
		operation_kind: "explore",
	};
	expect(validateToolCallRecord(tool)).toEqual([]);
	expect(validateToolCallRecord({ ...tool, depth: 0 })).toContainEqual(expect.stringContaining("unexpected key: depth"));
});
