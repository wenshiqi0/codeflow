import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
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
