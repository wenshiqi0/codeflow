import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import telemetryLedger, { operationKind } from "../../runtime/extensions/telemetry-ledger";
import { createGoal } from "../../runtime/lib/goals";
import { recordRuntimeFailure, submitReceipt } from "../../runtime/lib/commitment";
import { claimTestWork } from "./helpers";
import { scanCommitmentStates } from "../../runtime/lib/observability/commitment-state";
import { summarizeCommitmentStates } from "../../runtime/lib/observability/summary";
import { validateAttemptUsageRecord } from "../../runtime/lib/observability/model-usage";
import { TOOL_CALL_SCHEMA_VERSION, validateToolCallRecord } from "../../runtime/lib/observability/tool-execution";
import { summarizeWallBreakdown } from "../../runtime/lib/observability/timing";
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
		commitment_id: "c_1",
		goal_id: "task-a",
		usage: { input: 1, output: 1, reasoning: 0, cache_read: 0, cache_write: 0, total_tokens: 2, cost: null },
	};
	expect(validateAttemptUsageRecord(usage)).toEqual([]);
	expect(validateAttemptUsageRecord({ ...usage, role: "planner" })).toContainEqual(expect.stringContaining("unexpected key: role"));
	const tool = {
		schema_version: TOOL_CALL_SCHEMA_VERSION,
		kind: "requested",
		call_id: "call-1",
		tool: "read",
		status: null,
		at: new Date(0).toISOString(),
		task_id: "task-a",
		worker_kind: "worker",
		commitment_id: "c_1",
		goal_id: "task-a",
		provider: "provider",
		model: "model",
		operation_kind: "source_discovery",
	};
	expect(validateToolCallRecord(tool)).toEqual([]);
	expect(validateToolCallRecord({ ...tool, depth: 0 })).toContainEqual(expect.stringContaining("unexpected key: depth"));
});

test("telemetry records request start and message_end wall time as provider latency", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-telemetry-"));
	dirs.push(root);
	const previousLedger = process.env.CODEFLOW_BENCHMARK_DRIVER_LEDGER_DIR;
	process.env.CODEFLOW_BENCHMARK_DRIVER_LEDGER_DIR = root;
	try {
		const handlers = new Map<string, (event: any) => void>();
		telemetryLedger({ on(name: string, handler: (event: any) => void) { handlers.set(name, handler); } } as never);
		handlers.get("turn_start")?.({ turnIndex: 0 });
		await Bun.sleep(25);
		const messageOrigin = Date.now() + 60_000;
		handlers.get("message_end")?.({
			message: {
				role: "assistant",
				timestamp: messageOrigin,
				provider: "provider",
				model: "model",
				usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
			},
		});
		const usage = JSON.parse(fs.readFileSync(path.join(root, "usage.jsonl"), "utf8"));
		expect(usage.request_started_at).not.toBeNull();
		expect(Date.parse(usage.request_started_at)).toBeLessThanOrEqual(Date.parse(usage.at));
		expect(usage.at).not.toBe(new Date(messageOrigin).toISOString());
		const observedSeconds = (Date.parse(usage.at) - Date.parse(usage.request_started_at)) / 1_000;
		expect(observedSeconds).toBeGreaterThanOrEqual(0.02);
		const breakdown = summarizeWallBreakdown(
			[usage],
			[],
			observedSeconds,
			Date.parse(usage.request_started_at),
		);
		expect(breakdown.provider_wait_derived_seconds).toBe(observedSeconds);
		expect(breakdown.local_overhead_derived_seconds).toBe(0);
	} finally {
		if (previousLedger === undefined) delete process.env.CODEFLOW_BENCHMARK_DRIVER_LEDGER_DIR;
		else process.env.CODEFLOW_BENCHMARK_DRIVER_LEDGER_DIR = previousLedger;
	}
});

test("collaborate actions preserve privacy-safe organization telemetry categories", () => {
	for (const action of ["inspect", "claim", "report", "delegate", "wait"] as const) {
		expect(operationKind("collaborate", { action: { name: action } })).toBe(action);
	}
	expect(operationKind("collaborate", { action: { name: "unknown" } })).toBe("other");
	expect(operationKind("read", { path: "runtime/lib/state.ts" })).toBe("source_discovery");
	expect(operationKind("bash", { command: "rg -n collaborate runtime" })).toBe("source_discovery");
	expect(operationKind("bash", { command: "bun test tests/runtime" })).toBe("execute");
	expect(operationKind("bash", { command: "codeteam evidence run --id unit -- true" })).toBe("evidence_run");
	expect(operationKind("bash", { command: "codeteam evidence log unit" })).toBe("evidence_log");
	expect(operationKind("bash", { command: "codeteam check source" })).toBe("execute");
});
