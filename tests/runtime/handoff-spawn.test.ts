import { afterEach, describe, expect, test } from "bun:test";
import { spawn as childSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeHandoffSpawn, type HandoffSpawnParams } from "../../runtime/extensions/codeflow-organization";
import { spawnWorker, type WorkerExecution } from "../../runtime/extensions/codeflow-organization/worker-launcher";
import { createGoal, goalRecords } from "../../runtime/lib/goals";
import { handoffHistory, handoffView, openHandoff, startHandoff, submitReceipt } from "../../runtime/lib/handoff";
import { projectHandoffState } from "../../runtime/lib/observability/handoff-state";
import { RunPaths } from "../../runtime/lib/paths";
import { createTask } from "../../runtime/lib/tasks";

const dirs: string[] = [];
const originalRunId = process.env.CODEFLOW_RUN_ID;
const originalRunsDir = process.env.CODEFLOW_RUNS_DIR;
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	if (originalRunId === undefined) delete process.env.CODEFLOW_RUN_ID;
	else process.env.CODEFLOW_RUN_ID = originalRunId;
	if (originalRunsDir === undefined) delete process.env.CODEFLOW_RUNS_DIR;
	else process.env.CODEFLOW_RUNS_DIR = originalRunsDir;
});

function runtime(): RunPaths {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-spawn-"));
	dirs.push(root);
	const paths = new RunPaths(path.join(root, "runs"), "task-spawn");
	createTask(paths, "spawn work");
	return paths;
}

function params(overrides: Partial<HandoffSpawnParams> = {}): HandoffSpawnParams {
	return {
		digest: "delegated work",
		intent: "deliver delegated outcome",
		expected_outcome: ["outcome exists"],
		...overrides,
	};
}

function counts(paths: RunPaths) {
	const count = (directory: string) => fs.existsSync(directory) ? fs.readdirSync(directory).length : 0;
	return {
		goals: goalRecords(paths).length,
		handoffs: handoffHistory(paths).length,
		goal_claims: count(`${paths.goalSeq}.d`),
		semantic_claims: count(`${paths.semanticSeq}.d`),
		event_claims: count(`${paths.eventSeq}.d`),
		events: count(paths.events),
		active: count(paths.active),
	};
}

function completingLauncher(paths: RunPaths) {
	return async (handoffId: string): Promise<WorkerExecution> => {
		startHandoff(paths, handoffId);
		const receipt = submitReceipt(paths, { handoffId, status: "completed" });
		return {
			handoff_id: handoffId,
			exit_code: 0,
			stop_reason: "stop",
			receipt_id: receipt.id,
			status: receipt.status,
			runtime_failure_reasons: [],
			retryable: false,
		};
	};
}

describe("handoff_spawn compound contract", () => {
	test("one call creates an inline Goal, Handoff, execution, and Receipt", async () => {
		const paths = runtime();
		const parent = openHandoff(paths, { goalId: paths.runId, digest: "root", intent: "root", expectedOutcome: ["done"] });
		const result = await executeHandoffSpawn(
			paths,
			params({ goal: { id: "child", objective: "child outcome" } }),
			parent.id,
			undefined,
			process.cwd(),
			completingLauncher(paths),
		);
		expect(result.status).toBe("completed");
		expect(goalRecords(paths).map((goal) => goal.id)).toEqual(["child"]);
		const child = handoffHistory(paths).find((view) => view.handoff.id === result.handoff_id)!;
		expect(child.handoff).toMatchObject({ goal_id: "child", parent_handoff_id: parent.id });
		expect(child.receipt?.id).toBe(result.receipt_id);
	});

	test("validation and dependency rejection allocate no sequence or durable state", async () => {
		const paths = runtime();
		createGoal(paths, { id: "dependency", objective: "dependency" });
		createGoal(paths, { id: "waiting", objective: "waiting", dependencies: ["dependency"] });
		const baseline = counts(paths);
		await expect(executeHandoffSpawn(
			paths,
			params({ goal: { id: "new-goal", objective: "new" }, expected_outcome: [] }),
			null,
			undefined,
			process.cwd(),
			completingLauncher(paths),
		)).rejects.toThrow(/expected_outcome/);
		expect(counts(paths)).toEqual(baseline);
		await expect(executeHandoffSpawn(
			paths,
			params({ goal_id: "waiting" }),
			null,
			undefined,
			process.cwd(),
			completingLauncher(paths),
		)).rejects.toThrow(/dependencies/);
		expect(counts(paths)).toEqual(baseline);
		await expect(executeHandoffSpawn(
			paths,
			params({ goal: { id: "x", objective: "x" }, goal_id: "waiting" }),
			null,
			undefined,
			process.cwd(),
			completingLauncher(paths),
		)).rejects.toThrow(/mutually exclusive/);
		expect(counts(paths)).toEqual(baseline);
	});

	test("a launcher exception preserves semantics, clears active state, and remains retryable", async () => {
		const paths = runtime();
		const result = await executeHandoffSpawn(
			paths,
			params({ goal: { id: "retry", objective: "retry outcome" } }),
			null,
			undefined,
			process.cwd(),
			async () => { throw new Error("launcher failed"); },
		);
		expect(result).toMatchObject({ status: "interrupted", retryable: true, runtime_failure_reasons: ["WORKER_LAUNCH_FAILURE"] });
		expect(goalRecords(paths)).toHaveLength(1);
		expect(handoffView(paths, handoffHistory(paths)[0].handoff).status).toBe("open");
		expect(projectHandoffState(paths, result.handoff_id).runtime_failure_reasons).toEqual(["WORKER_LAUNCH_FAILURE"]);
		const retried = await completingLauncher(paths)(result.handoff_id);
		expect(retried.status).toBe("completed");
	});
});

describe("worker_spawn launch failure envelope", () => {
	function configure(paths: RunPaths): void {
		process.env.CODEFLOW_RUN_ID = paths.runId;
		process.env.CODEFLOW_RUNS_DIR = paths.code;
	}

	const resolved = {
		provider: "test-provider",
		model: "test-model",
		systemPrompt: "test",
		promptPath: "/tmp/worker.md",
	};

	test("configuration and OS spawn failures clear active state and use WORKER_LAUNCH_FAILURE", async () => {
		const paths = runtime();
		configure(paths);
		const configFailure = openHandoff(paths, { goalId: paths.runId, digest: "config", intent: "config", expectedOutcome: ["done"] });
		const configResult = await spawnWorker(configFailure.id, undefined, process.cwd(), {
			resolve: () => { throw new Error("bad config"); },
		});
		expect(configResult.runtime_failure_reasons).toEqual(["WORKER_LAUNCH_FAILURE"]);
		expect(handoffView(paths, configFailure).status).toBe("open");

		const osFailure = openHandoff(paths, { goalId: paths.runId, digest: "os", intent: "os", expectedOutcome: ["done"] });
		const osResult = await spawnWorker(osFailure.id, undefined, process.cwd(), {
			resolve: () => resolved,
			spawnProcess: (() => childSpawn("/definitely/missing-codeflow-worker", [], { stdio: ["ignore", "pipe", "pipe"] })) as typeof childSpawn,
		});
		expect(osResult.runtime_failure_reasons).toEqual(["WORKER_LAUNCH_FAILURE"]);
		expect(handoffView(paths, osFailure).status).toBe("open");
	});

	test("a process that starts and exits nonzero remains a provider failure", async () => {
		const paths = runtime();
		configure(paths);
		const handoff = openHandoff(paths, { goalId: paths.runId, digest: "provider", intent: "provider", expectedOutcome: ["done"] });
		const result = await spawnWorker(handoff.id, undefined, process.cwd(), {
			resolve: () => resolved,
			spawnProcess: (() => childSpawn(process.execPath, ["-e", "process.exit(1)"], { stdio: ["ignore", "pipe", "pipe"] })) as typeof childSpawn,
		});
		expect(result.runtime_failure_reasons).toEqual(["PROVIDER_FAILURE"]);
		expect(result.runtime_failure_reasons).not.toContain("WORKER_LAUNCH_FAILURE");
	});
});
