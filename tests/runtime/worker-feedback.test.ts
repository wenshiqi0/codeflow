import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import {
	cancelWorkers,
	delegateWorker,
	hasLiveWorkers,
	takeWorkerUpdates,
} from "../../runtime/extensions/codeflow-organization/worker-launcher";
import { submitReceipt } from "../../runtime/lib/commitment";
import { RunPaths } from "../../runtime/lib/paths";
import { createTask } from "../../runtime/lib/tasks";
import { claimTestWork } from "./helpers";

const dirs: string[] = [];
const children = new Set<FakeChild>();
const ENV_KEYS = ["CODEFLOW_RUN_ID", "CODEFLOW_RUNS_DIR"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let sequence = 0;

class FakeChild extends EventEmitter {
	pid = 100_000 + ++sequence;
	stdout = new PassThrough();
	stderr = new PassThrough();
	exitCode: number | null = null;
	signalCode = null;
	killedWith: string[] = [];

	close(code = 0) {
		if (this.exitCode !== null) return;
		this.exitCode = code;
		this.emit("close", code);
	}

	kill(signal: string) {
		this.killedWith.push(signal);
		queueMicrotask(() => this.close(1));
		return true;
	}
}

async function settleChildren() {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(async () => {
	for (const child of children) child.close();
	await settleChildren();
	takeWorkerUpdates();
	children.clear();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	for (const key of ENV_KEYS) {
		const value = originalEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function runtime() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-worker-feedback-"));
	dirs.push(root);
	const paths = new RunPaths(path.join(root, "runs"), `task-feedback-${++sequence}`);
	createTask(paths, "deliver nonblocking Worker feedback");
	process.env.CODEFLOW_RUN_ID = paths.runId;
	process.env.CODEFLOW_RUNS_DIR = paths.code;
	const parent = claimTestWork(paths, {
		goalId: paths.runId,
		work: "coordinate independent feedback",
	});
	return { paths, root, parent };
}

function launch(fixture: ReturnType<typeof runtime>, signal?: AbortSignal) {
	const executionId = `exec-feedback-${++sequence}`;
	const child = new FakeChild();
	children.add(child);
	const result = delegateWorker({
		goalId: fixture.paths.runId,
		focus: "inspect and own an independent boundary",
		parentCommitmentId: fixture.parent.id,
	}, signal, fixture.root, {
		executionId,
		resolve: () => ({
			provider: "test-provider",
			model: "test-model",
			systemPrompts: ["worker"],
			promptPaths: ["/tmp/worker.md"],
		}),
		spawnProcess: (() => child) as never,
	});
	expect(result).toEqual({ execution_id: executionId, goal_id: fixture.paths.runId, status: "running" });
	return { executionId, child };
}

function claim(fixture: ReturnType<typeof runtime>, executionId: string, work = "establish an independent result") {
	return claimTestWork(fixture.paths, {
		goalId: fixture.paths.runId,
		parentCommitmentId: fixture.parent.id,
		workerExecutionId: executionId,
		work,
	});
}

describe("nonblocking Worker feedback", () => {
	test("an in-flight Claim publication does not consume or lose later feedback", () => {
		const fixture = runtime();
		const worker = launch(fixture);
		const commitment = claim(fixture, worker.executionId);
		const target = fixture.paths.commitmentPath(commitment.id);
		const staging = path.join(fixture.paths.commitmentDir(commitment.id), ".commitment.in-flight.tmp");
		fs.renameSync(target, staging);
		expect(takeWorkerUpdates()).toEqual([]);
		fs.renameSync(staging, target);
		expect(takeWorkerUpdates()).toMatchObject([{ commitment_id: commitment.id, status: "running" }]);
		expect(takeWorkerUpdates()).toEqual([]);
	});

	test("tester feedback is available while development remains running", async () => {
		const fixture = runtime();
		const developer = launch(fixture);
		const tester = launch(fixture);
		const development = claim(fixture, developer.executionId);
		const testing = claim(fixture, tester.executionId);
		expect(takeWorkerUpdates().map((update) => update.commitment_id)).toEqual([development.id, testing.id]);
		const progress = submitReceipt(fixture.paths, {
			commitmentId: testing.id,
			status: "progress",
			summary: "independent test exposed a compatibility counterexample",
		});
		expect(takeWorkerUpdates()).toEqual([{
			execution_id: tester.executionId,
			goal_id: fixture.paths.runId,
			commitment_id: testing.id,
			receipt_id: progress.id,
			status: "progress",
		}]);
		expect(developer.child.exitCode).toBeNull();
		expect(hasLiveWorkers()).toBe(true);
	});

	test("no new feedback returns an immediate empty array, not a Promise", () => {
		const fixture = runtime();
		launch(fixture);
		const updates = takeWorkerUpdates();
		expect(updates).toEqual([]);
		expect(updates).not.toBeInstanceOf(Promise);
		expect(takeWorkerUpdates()).toEqual([]);
	});

	test("a fast exit cannot drop Claim, progress, terminal Receipt, or execution result", async () => {
		const fixture = runtime();
		const worker = launch(fixture);
		const commitment = claim(fixture, worker.executionId);
		const progress = submitReceipt(fixture.paths, { commitmentId: commitment.id, status: "progress", summary: "checked the boundary" });
		const terminal = submitReceipt(fixture.paths, { commitmentId: commitment.id, status: "completed", summary: "delivered the result" });
		worker.child.close();
		await settleChildren();
		expect(hasLiveWorkers()).toBe(false);
		const updates = takeWorkerUpdates();
		expect(updates).toHaveLength(4);
		expect(updates[0]).toMatchObject({ commitment_id: commitment.id, status: "running" });
		expect(updates[1]).toMatchObject({ receipt_id: progress.id, status: "progress" });
		expect(updates[2]).toMatchObject({ receipt_id: terminal.id, status: "completed" });
		expect(updates[3]).toMatchObject({ execution_id: worker.executionId, receipt_id: terminal.id, exit_code: 0 });
		expect(takeWorkerUpdates()).toEqual([]);
	});

	test("multiple Commitments within one execution preserve every durable record in sequence order", async () => {
		const fixture = runtime();
		const firstWorker = launch(fixture);
		const secondWorker = launch(fixture);
		const first = claim(fixture, firstWorker.executionId, "first boundary");
		const other = claim(fixture, secondWorker.executionId, "parallel boundary");
		const firstResult = submitReceipt(fixture.paths, { commitmentId: first.id, status: "completed", summary: "first result" });
		const second = claim(fixture, firstWorker.executionId, "new evidence requires follow-up work");
		const nextProgress = submitReceipt(fixture.paths, { commitmentId: second.id, status: "progress", summary: "follow-up evidence" });
		const ids = takeWorkerUpdates().map((update) => "receipt_id" in update ? update.receipt_id : update.commitment_id);
		expect(ids).toEqual([first.id, other.id, firstResult.id, second.id, nextProgress.id]);
		expect(takeWorkerUpdates()).toEqual([]);
		const terminal = submitReceipt(fixture.paths, { commitmentId: second.id, status: "completed", summary: "follow-up complete" });
		firstWorker.child.close();
		await settleChildren();
		expect(takeWorkerUpdates()).toMatchObject([
			{ receipt_id: terminal.id, status: "completed" },
			{ commitment_id: second.id, receipt_id: terminal.id, exit_code: 0 },
		]);
	});

	test("a failed launch reports an execution result without inventing a Claim", async () => {
		const fixture = runtime();
		const executionId = `exec-feedback-${++sequence}`;
		delegateWorker({ goalId: fixture.paths.runId, focus: "bounded work", parentCommitmentId: fixture.parent.id }, undefined, fixture.root, {
			executionId,
			resolve() { throw new Error("configuration unavailable"); },
		});
		await settleChildren();
		expect(takeWorkerUpdates()).toMatchObject([{
			execution_id: executionId,
			commitment_id: null,
			status: "interrupted",
			runtime_failure_reasons: ["WORKER_LAUNCH_FAILURE"],
		}]);
		expect(takeWorkerUpdates()).toEqual([]);
	});

	test("feedback stays bound to launch paths when process environment changes", async () => {
		const original = runtime();
		const worker = launch(original);
		const commitment = claim(original, worker.executionId);
		const different = runtime();
		expect(process.env.CODEFLOW_RUN_ID).toBe(different.paths.runId);
		const terminal = submitReceipt(original.paths, { commitmentId: commitment.id, status: "completed", summary: "original Task completed" });
		worker.child.close();
		await settleChildren();
		expect(takeWorkerUpdates()).toMatchObject([
			{ goal_id: original.paths.runId, commitment_id: commitment.id, status: "running" },
			{ goal_id: original.paths.runId, receipt_id: terminal.id, status: "completed" },
			{ goal_id: original.paths.runId, receipt_id: terminal.id, exit_code: 0 },
		]);
	});

	test("cancellation reaches Children from every Root turn without aborting on normal completion", async () => {
		const fixture = runtime();
		const earlierTurn = new AbortController();
		const laterTurn = new AbortController();
		const earlier = launch(fixture, earlierTurn.signal);
		const later = launch(fixture, laterTurn.signal);
		expect(earlier.child.killedWith).toEqual([]);
		expect(later.child.killedWith).toEqual([]);
		cancelWorkers();
		await settleChildren();
		expect(earlier.child.killedWith).toEqual(["SIGTERM"]);
		expect(later.child.killedWith).toEqual(["SIGTERM"]);
		expect(hasLiveWorkers()).toBe(false);
		const endings = takeWorkerUpdates();
		expect(endings).toHaveLength(2);
		for (const ending of endings) {
			expect(ending).toMatchObject({ status: "interrupted", runtime_failure_reasons: ["USER_CANCELLED", "PROVIDER_FAILURE"] });
		}
		earlierTurn.abort();
		laterTurn.abort();
		expect(earlier.child.killedWith).toEqual(["SIGTERM"]);
		expect(later.child.killedWith).toEqual(["SIGTERM"]);
	});
});
