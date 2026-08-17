import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { openRootHandoffForRun } from "../../runtime/cli/run";
import { RunPaths, readJson } from "../../runtime/lib/paths";

describe("run root handoff", () => {
	test("exec has a mechanical root handoff for the planner", () => {
		const paths = new RunPaths(".codeflow/runs/code", "run-root-test");
		fs.rmSync(paths.runDir, { recursive: true, force: true });
		try {
			const opened = openRootHandoffForRun(paths, "planner", "Add a playable puzzle game");
			const state = readJson<any>(opened.state);

			expect(opened.handoff_id).toBe("h00001-planner");
			expect(state.depth).toBe(0);
			expect(state.lineage.parent_handoff_id).toBeNull();
			expect(state.status).toBe("open");
			expect(readJson<any>(opened.state).goal).toBe("Add a playable puzzle game");
		} finally {
			fs.rmSync(paths.runDir, { recursive: true, force: true });
		}
	});
});

describe("exec output boundary", () => {
	test("the depth-0 Pi stream is piped and drained, not inherited", () => {
		const source = fs.readFileSync(
			path.resolve(import.meta.dir, "../../runtime/cli/run.ts"),
			"utf8",
		);
		expect(source).toContain('stdout: captureRootOutput ? "pipe" : "inherit"');
		expect(source).toContain('stderr: captureRootOutput ? "pipe" : "inherit"');
		expect(source).toContain("const rootOutputDrained = captureRootOutput");
		expect(source).toContain("ROOT_OUTPUT_DIAGNOSTIC_LIMIT");
		expect(source).toContain("planner exited with code");
	});
});
