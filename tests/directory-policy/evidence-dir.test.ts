import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { currentEvidenceDir } from "../../runtime/extensions/codeflow-task/role-launcher";

const REPO = path.resolve(import.meta.dir, "../..");

describe("evidence directory policy", () => {
	test("the current evidence directory is absolute and outside the workspace", () => {
		const previousRun = process.env.CODEFLOW_RUN_ID;
		const previousRuns = process.env.CODEFLOW_RUNS_DIR;
		const workspace = fs.mkdtempSync("/tmp/codeflow-evidence-policy-");
		const runsRoot = path.join(path.dirname(workspace), `${path.basename(workspace)}-runs`);
		const runsDir = path.join(runsRoot, "code");
		process.env.CODEFLOW_RUN_ID = "run-evidence-policy";
		process.env.CODEFLOW_RUNS_DIR = runsDir;
		try {
			const evidence = currentEvidenceDir();
			expect(evidence).toBeDefined();
			expect(path.isAbsolute(evidence!)).toBe(true);
			expect(path.relative(workspace, evidence!).startsWith("..")).toBe(true);
			expect(evidence!).toBe(path.join(runsRoot, "evidence", "run-evidence-policy"));
		} finally {
			if (previousRun === undefined) delete process.env.CODEFLOW_RUN_ID;
			else process.env.CODEFLOW_RUN_ID = previousRun;
			if (previousRuns === undefined) delete process.env.CODEFLOW_RUNS_DIR;
			else process.env.CODEFLOW_RUNS_DIR = previousRuns;
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	test("prompt contracts use the absolute evidence environment root", () => {
	const agents = fs.readFileSync(path.join(REPO, "runtime/AGENTS.md"), "utf8");
	const testing = fs.readFileSync(path.join(REPO, "references/capabilities/testing.md"), "utf8");
	const implementation = fs.readFileSync(path.join(REPO, "references/capabilities/implementation.md"), "utf8");
	expect(agents).not.toContain("below `.codeflow/runs/`");
	expect(agents).toContain("$CODEFLOW_EVIDENCE_DIR");
	expect(testing).toContain("$CODEFLOW_EVIDENCE_DIR/<goal-id>/test/");
	expect(implementation).toContain("$CODEFLOW_EVIDENCE_DIR/<goal-id>/code/");
	});
});
