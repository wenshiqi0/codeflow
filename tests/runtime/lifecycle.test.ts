import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openRootHandoffForRun } from "../../runtime/cli/run";
import { loadReceipt, runResume, runnerChildStarted, runnerExited, runStart, startHandoff, submitReceipt } from "../../runtime/lib/handoff";
import { RunPaths } from "../../runtime/lib/paths";
import { assertResumeStopped } from "../../runtime/lib/resume";
import { scan } from "../../runtime/lib/wait";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function runtime(): RunPaths {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-lifecycle-"));
	dirs.push(root);
	return new RunPaths(path.join(root, "runs"), "task-lifecycle");
}

describe("attempt lifecycle", () => {
	test("runtime interruption records no Receipt and permits an explicit resume", () => {
		const paths = runtime();
		runStart(paths, 100, "finish work");
		const root = openRootHandoffForRun(paths, "finish work");
		startHandoff(paths, root.id);
		runnerChildStarted(paths, 200);
		// Match the Pi process identity recorded on the active Handoff.
		const active = path.join(paths.active, `${root.id}.json`);
		fs.writeFileSync(active, JSON.stringify({ started: true, pid: 200 }));
		runnerExited(paths, 200, true, { reasons: ["PROVIDER_FAILURE"], summary: "provider ended" });
		expect(loadReceipt(paths, root.id)).toBeNull();
		const kinds = scan(paths.events, 0, []).events.map((event) => event.kind);
		expect(kinds).toContain("execution_interrupted");
		expect(kinds).toContain("run_interrupted");
		expect(kinds.at(-1)).toBe("runner_exited");
		expect(assertResumeStopped(paths).startSeq).toBeGreaterThan(0);
		expect(runResume(paths, 300).resume_count).toBe(1);
		startHandoff(paths, root.id, 301);
	});

	test("semantic closure emits run_finished and never run_interrupted", () => {
		const paths = runtime();
		runStart(paths, 100, "finish work");
		const root = openRootHandoffForRun(paths, "finish work");
		startHandoff(paths, root.id, 200);
		submitReceipt(paths, { handoffId: root.id, status: "completed", established: ["done"] });
		runnerExited(paths, 200, true);
		const kinds = scan(paths.events, 0, []).events.map((event) => event.kind);
		expect(kinds).toContain("run_finished");
		expect(kinds).not.toContain("run_interrupted");
		expect(assertResumeStopped(paths).startSeq).toBeGreaterThan(0);
	});
});
