import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commitmentHistory, loadReceiptChain, reconcileDeadCommitments, resumeCommitment, runResume, runnerChildStarted, runnerExited, runStart, submitReceipt } from "../../runtime/lib/commitment";
import { RunPaths } from "../../runtime/lib/paths";
import { assertResumeStopped } from "../../runtime/lib/resume";
import { scan } from "../../runtime/lib/wait";
import { claimTestWork } from "./helpers";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function runtime(): RunPaths {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-lifecycle-"));
	dirs.push(root);
	return new RunPaths(path.join(root, "runs"), "task-lifecycle");
}

describe("attempt lifecycle", () => {
	test("confirmed-dead descendant executions recover without replacing Commitments or clearing live siblings", async () => {
		const paths = runtime();
		runStart(paths, process.pid, "recover recursive work");
		const deadProcess = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
		await deadProcess.exited;
		const root = claimTestWork(paths, { goalId: paths.runId, pid: deadProcess.pid, work: "parent" });
		const child = claimTestWork(paths, { goalId: paths.runId, parentCommitmentId: root.id, pid: deadProcess.pid, work: "child" });
		const live = claimTestWork(paths, { goalId: paths.runId, parentCommitmentId: root.id, pid: process.pid, work: "live sibling" });
		expect(reconcileDeadCommitments(paths, ["USER_CANCELLED"], [child.id])).toBe(1);
		expect(commitmentHistory(paths).find((view) => view.commitment.id === root.id)?.pid).toBe(deadProcess.pid);
		expect(reconcileDeadCommitments(paths, ["USER_CANCELLED"])).toBe(1);
		expect(commitmentHistory(paths).find((view) => view.commitment.id === live.id)?.pid).toBe(process.pid);
		resumeCommitment(paths, root.id, "new-root-execution", process.pid);
		resumeCommitment(paths, child.id, "new-child-execution", process.pid);
		expect(commitmentHistory(paths)).toHaveLength(3);
		expect(loadReceiptChain(paths, child.id).terminal).toBeNull();
	});

	test("runtime interruption records no Receipt and permits an explicit resume", () => {
		const paths = runtime();
		runStart(paths, 100, "finish work");
		const root = claimTestWork(paths, { goalId: paths.runId, workerExecutionId: "exec-root", pid: 200, work: "finish work" });
		runnerChildStarted(paths, 200);
		runnerExited(paths, 200, true, "exec-root", { reasons: ["PROVIDER_FAILURE"], summary: "provider ended" });
		expect(loadReceiptChain(paths, root.id).terminal).toBeNull();
		const kinds = scan(paths.events, 0, []).events.map((event) => event.kind);
		expect(kinds).toContain("execution_interrupted");
		expect(kinds).toContain("run_interrupted");
		expect(kinds.at(-1)).toBe("runner_exited");
		expect(assertResumeStopped(paths).startSeq).toBeGreaterThan(0);
		expect(runResume(paths, 300).resume_count).toBe(1);
		resumeCommitment(paths, root.id, "exec-resume", 301);
	});

	test("semantic closure emits run_finished and never run_interrupted", () => {
		const paths = runtime();
		runStart(paths, 100, "finish work");
		const root = claimTestWork(paths, { goalId: paths.runId, workerExecutionId: "exec-root", pid: 200, work: "finish work" });
		submitReceipt(paths, { commitmentId: root.id, status: "completed", summary: "done" });
		runnerExited(paths, 200, true, "exec-root");
		const kinds = scan(paths.events, 0, []).events.map((event) => event.kind);
		expect(kinds).toContain("run_finished");
		expect(kinds).not.toContain("run_interrupted");
		expect(assertResumeStopped(paths).startSeq).toBeGreaterThan(0);
	});

	test("durable progress survives interruption and the same Commitment can resume to one terminal closure", () => {
		const paths = runtime();
		runStart(paths, 100, "finish work");
		const root = claimTestWork(paths, { goalId: paths.runId, workerExecutionId: "exec-root", pid: 200, work: "finish work" });
		submitReceipt(paths, { commitmentId: root.id, status: "progress", summary: "durable finding" });
		runnerExited(paths, 200, true, "exec-root");
		const interrupted = scan(paths.events, 0, ["run_interrupted"]).events;
		expect(interrupted).toHaveLength(1);
		expect(interrupted[0].reasons).toEqual(["TERMINAL_RECEIPT_MISSING"]);
		expect(loadReceiptChain(paths, root.id).summaries).toEqual(["durable finding"]);

		runResume(paths, 300);
		resumeCommitment(paths, root.id, "exec-resume", 301);
		submitReceipt(paths, { commitmentId: root.id, status: "completed", summary: "finished" });
		runnerExited(paths, 301, true, "exec-resume");
		const lifecycle = scan(paths.events, 0, ["run_finished", "run_interrupted", "runner_exited"]).events;
		expect(lifecycle.filter((event) => event.kind === "run_finished")).toHaveLength(1);
		expect(lifecycle.filter((event) => event.kind === "run_interrupted")).toHaveLength(1);
		expect(loadReceiptChain(paths, root.id).receipts).toHaveLength(2);
		expect(() => submitReceipt(paths, { commitmentId: root.id, status: "progress", summary: "late" })).toThrow(/already closed/);
	});
});
