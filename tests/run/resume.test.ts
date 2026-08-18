import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	finishHandoff,
	openHandoff,
	runResume,
	runStart,
	runnerExited,
} from "../../runtime/lib/handoff";
import { RunPaths, readJson } from "../../runtime/lib/paths";
import { assertResumeStopped, loadResumeSource } from "../../runtime/lib/resume";

let root: string;
let paths: RunPaths;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-resume-"));
	paths = new RunPaths(path.join(root, "code"), "run-resume-test");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function openRoot(): ReturnType<typeof openHandoff> {
	return openHandoff(paths, {
		role: "planner",
		depth: 0,
		body: "Goal: continue the original requirement\n",
	});
}

function finishAttempt(pid: number): void {
	const rootHandoff = openRoot();
	finishHandoff(paths, {
		handoffId: rootHandoff.handoff_id,
		status: "BLOCKED",
		summary: "external correction required",
		blockedReasons: ["PROVIDER_FAILURE"],
	});
	runnerExited(paths, pid, "planner", 0);
}

describe("resume source", () => {
	test("requires the latest attempt to finish and exit", () => {
		runStart(paths, "planner", 1001, "preserve exact requirement");
		expect(() => loadResumeSource(paths.code, paths.runId)).toThrow("not fully stopped");

		const rootHandoff = openRoot();
		finishHandoff(paths, {
			handoffId: rootHandoff.handoff_id,
			status: "BLOCKED",
			summary: "blocked",
			blockedReasons: ["PROVIDER_FAILURE"],
		});
		expect(() => loadResumeSource(paths.code, paths.runId)).toThrow("not fully stopped");

		runnerExited(paths, 1001, "planner", 0);
		expect(loadResumeSource(paths.code, paths.runId)).toEqual({
			runId: paths.runId,
			requirement: "preserve exact requirement",
		});
	});

	test("rejects missing, unsafe, and requirement-less runs", () => {
		expect(() => loadResumeSource(paths.code, "../escape")).toThrow("invalid run id");
		expect(() => loadResumeSource(paths.code, "run-missing")).toThrow("no such run");
		runStart(paths, "planner", 1001, "");
		expect(() => loadResumeSource(paths.code, paths.runId)).toThrow("no resumable requirement");
	});

	test("an older terminal attempt cannot authorize concurrent resume", () => {
		runStart(paths, "planner", 1001, "continue me");
		finishAttempt(1001);
		runResume(paths, "planner", 1002);

		expect(() => loadResumeSource(paths.code, paths.runId)).toThrow("not fully stopped");
		expect(() => runResume(paths, "planner", 1003)).toThrow("not fully stopped");
		finishAttempt(1002);
		expect(loadResumeSource(paths.code, paths.runId).requirement).toBe("continue me");
	});

	test("an atomic claim prevents two external callers from resuming one attempt", () => {
		runStart(paths, "planner", 1001, "continue me");
		finishAttempt(1001);
		const { startSeq } = assertResumeStopped(paths);
		const claims = path.join(paths.runDir, ".resume-claims");
		fs.mkdirSync(claims, { recursive: true });
		fs.writeFileSync(path.join(claims, String(startSeq)), "claimed\n");

		expect(() => runResume(paths, "planner", 1002)).toThrow("resume already claimed");
		expect(fs.readdirSync(paths.events).some((name) => name.includes("run_resumed"))).toBeFalse();
	});
});

describe("run resume metadata", () => {
	test("keeps the run id and requirement while rotating runner identity", () => {
		runStart(paths, "planner", 1001, "continue me");
		finishAttempt(1001);
		const result = runResume(paths, "planner", 2002);
		const runner = readJson<Record<string, unknown>>(path.join(paths.runDir, "runner.json"));

		expect(result).toMatchObject({ run_id: paths.runId, resume_count: 1 });
		expect(runner).toMatchObject({
			run_id: paths.runId,
			requirement: "continue me",
			pid: 2002,
			resume_count: 1,
		});
		expect(runner).not.toHaveProperty("child_pid");
		expect(fs.readdirSync(path.join(paths.runDir, ".resume-claims"))).toHaveLength(1);
		expect(fs.readdirSync(paths.events).some((name) => name.includes("run_resumed--STARTED"))).toBeTrue();
	});
});
