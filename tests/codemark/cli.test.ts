import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { VERSION } from "../../codemark/cli/run";
import { attachOrganizationUsage, createInitialOrganization, finalizeOrganization, publishInitialOrganization } from "../../codemark/lib/organization";
import { baseEnv, cleanupTmpDirs, makeTmpDir, REPO, runCodemark } from "./helpers";

afterEach(cleanupTmpDirs);

describe("retired Codemark live boundary", () => {
	test("all old live invocation forms fail closed without loading a model or writing artifacts", () => {
		const cwd = makeTmpDir();
		const env = { ...baseEnv(), CODEFLOW_HOME: cwd, CODEFLOW_AGENT_MODEL: "unavailable/model" };
		for (const args of [[], ["inspect issue"], ["--model", "a/b", "issue"], ["--out", "new-run", "issue"]]) {
			const result = runCodemark(args, { cwd, env, stdin: "issue from stdin" });
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("live runs are retired");
			expect(result.stderr).toContain("No model was started");
		}
		expect(fs.readdirSync(cwd)).toEqual([]);
		const source = fs.readFileSync(path.join(REPO, "codemark/cli/run.ts"), "utf8");
		expect(source).not.toMatch(/Bun\.spawn|resolveAgent|buildAgentArgv/);
	});

	test("help and version are credential-free and describe historical report only", () => {
		const help = runCodemark(["--help"]);
		expect(help.exitCode).toBe(0);
		expect(help.stdout).toContain("codemark report --run");
		expect(help.stdout).not.toContain("--model");
		expect(runCodemark(["--version"]).stdout.trim()).toBe(`codemark ${VERSION}`);
	});

	test("reports immutable v1 artifacts without treating them as an outer orchestration measurement", () => {
		const dir = path.join(makeTmpDir(), "historical");
		createInitialOrganization(dir, { runId: "task-historical", issue: "Inspect behavior", repository: REPO });
		finalizeOrganization(dir, { termination: "first_turn_end" });
		attachOrganizationUsage(dir, { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, total_tokens: 0, cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 } });
		publishInitialOrganization(dir);
		const file = path.join(dir, "initial-organization.json");
		const before = fs.readFileSync(file, "utf8");
		const result = runCodemark(["report", "--run", dir]);
		expect(result.exitCode).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.outer_orchestration_measurement).toBe(false);
		expect(report.artifact.schema_version).toBe(1);
		expect(report.artifact.run_id).toBe("task-historical");
		expect(fs.readFileSync(file, "utf8")).toBe(before);
	});

	test("rejects corrupt and incomplete report arguments without fabricating a result", () => {
		expect(runCodemark(["report"]).exitCode).toBe(2);
		expect(runCodemark(["report", "--run", makeTmpDir()]).exitCode).toBe(1);
	});
});
