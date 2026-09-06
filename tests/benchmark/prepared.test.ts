import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { prepareBenchmark, evaluatePreparedBenchmark, reportPreparedBenchmark } from "../../benchmark/lib/prepared";
import { prepareBenchmarkWorkspace } from "../../benchmark/lib/workspace";
import { createTeam, finishTeam, teamStatus } from "../../runtime/lib/team";
import { claimCommitment, goalClaimRevision, submitReceipt } from "../../runtime/lib/commitment";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../runtime/lib/paths";
import { cleanupTmpDirs, makeTmpDir } from "./helpers";

afterEach(cleanupTmpDirs);

function prepareCase() {
	const dir = makeTmpDir("benchmark-prepared-");
	const snapshot = path.join(dir, "dataset.json");
	fs.writeFileSync(snapshot, JSON.stringify({ schema_version: 1, dataset_id: "SWE-bench/SWE-bench_Verified", split: "test", revision: "a".repeat(40), harness_commit: "7a21e05772954cc81471ae19d56f436cecf43c54", instances: [{
		instance_id: "sample__repo-1", repo: "sample/repo", base_commit: "b".repeat(40), problem_statement: "Correct the sample behavior.",
		patch: "CANARY_GOLD", test_patch: "CANARY_TEST", FAIL_TO_PASS: ["CANARY_LIST"], PASS_TO_PASS: [], future_secret: "CANARY_FUTURE",
	}] }));
	let received: unknown;
	const prepared = prepareBenchmark({ dataset: snapshot, instances: ["sample__repo-1"], outDir: path.join(dir, "prepared"), codeflowCommit: "c".repeat(40),
		provisionWorkspace(instance, workspace) { received = instance; prepareBenchmarkWorkspace(workspace); },
	});
	const workspace = prepared.cases[0].workspace;
	const paths = new RunPaths(path.join(workspace, DEFAULT_RUNS_DIR), "task-prepared");
	return { dir, snapshot, prepared, workspace, paths, received };
}

function finishFixtureTask(paths: RunPaths) {
	const claim = claimCommitment(paths, { goalId: paths.runId, workerExecutionId: "exec-offline", basedOnRevision: goalClaimRevision(paths, paths.runId), work: "Controlled offline fixture work" });
	submitReceipt(paths, { commitmentId: claim.id, status: "completed", summary: "Controlled fixture complete" });
	finishTeam(paths, "completed", "Candidate ready");
}

describe("outer-managed SWE prepare/evaluate", () => {
	test("prepare only provisions fresh workspaces and publishes the four-key projection", () => {
		const { prepared, received, snapshot } = prepareCase();
		const visible = JSON.parse(fs.readFileSync(prepared.cases[0].issue, "utf8"));
		expect(Object.keys(visible).sort()).toEqual(["base_commit", "instance_id", "problem_statement", "repo"]);
		expect(received).toEqual(visible);
		expect(JSON.stringify(prepared)).not.toContain("CANARY_");
		expect(prepared.manifest.execution_method).toBe("outer-managed");
		expect(prepared.manifest.outer_context_isolation).toBe("not_attested");
		expect(() => prepareBenchmark({ dataset: snapshot, instances: ["sample__repo-1"], outDir: prepared.out_dir })).toThrow();
		expect(reportPreparedBenchmark(prepared.out_dir).cases[0].verdict).toBe("not_evaluated");
	});

	test("an unfinished Task cannot freeze a patch or call the evaluator", async () => {
		const { prepared, workspace, paths } = prepareCase();
		createTeam(paths, "Correct the sample behavior", workspace);
		let calls = 0;
		await expect(evaluatePreparedBenchmark({ runDir: prepared.out_dir, taskId: paths.runId, modelConfig: "offline", evaluator: { async evaluate() { calls++; return "resolved"; } } })).rejects.toThrow(/codeteam finish/);
		expect(calls).toBe(0);
		expect(fs.existsSync(path.join(workspace, "../evaluation"))).toBe(false);
	});

	test("finished but active process metadata still fails closed", async () => {
		const { prepared, workspace, paths } = prepareCase();
		createTeam(paths, "Correct the sample behavior", workspace);
		finishFixtureTask(paths);
		const status = teamStatus(paths);
		await expect(evaluatePreparedBenchmark({ runDir: prepared.out_dir, taskId: paths.runId, modelConfig: "offline",
			readTeamStatus: () => ({ ...status, agents: [{ status: "idle", pid: 123, runner_pid: null }] as typeof status.agents }),
		})).rejects.toThrow(/fully stopped/);
	});

	test("freezes the uncommitted candidate and uses only the official evaluator verdict once", async () => {
		const { prepared, workspace, paths } = prepareCase();
		createTeam(paths, "Correct the sample behavior", workspace);
		fs.writeFileSync(path.join(workspace, "fixed.txt"), "fixed\n");
		finishFixtureTask(paths);
		let calls = 0;
		const evaluator = { async evaluate(request: any) {
			calls++;
			expect(Object.keys(request.prediction).sort()).toEqual(["instance_id", "model_name_or_path", "model_patch"]);
			expect(request.prediction.model_patch).toContain("+fixed");
			expect(request.prediction.model_patch).not.toContain(".codeflow");
			expect(JSON.stringify(request)).not.toContain("CANARY_");
			return "unresolved" as const;
		} };
		const result = await evaluatePreparedBenchmark({ runDir: prepared.out_dir, taskId: paths.runId, modelConfig: "offline", evaluator });
		expect(result.verdict).toBe("unresolved");
		expect(result.task_status).toBe("completed");
		expect(result.executor_usage).toBeNull();
		expect(result.outer_host_usage).toBeNull();
		expect(result.not_official).toBe(true);
		await expect(evaluatePreparedBenchmark({ runDir: prepared.out_dir, taskId: paths.runId, modelConfig: "offline", evaluator })).rejects.toThrow();
		expect(calls).toBe(1);
		expect(reportPreparedBenchmark(prepared.out_dir).cases[0].verdict).toBe("unresolved");
	});

	test("rejects a changed baseline instead of silently dropping committed edits", async () => {
		const { prepared, workspace, paths } = prepareCase();
		createTeam(paths, "Correct the sample behavior", workspace);
		finishTeam(paths, "blocked", "No candidate", ["Investigation remains"]);
		Bun.spawnSync(["git", "-C", workspace, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "unexpected commit"]);
		await expect(evaluatePreparedBenchmark({ runDir: prepared.out_dir, taskId: paths.runId, modelConfig: "offline" })).rejects.toThrow(/baseline changed/);
	});

	for (const outcome of ["not_evaluated", "infra_error"] as const) {
		test(`official ${outcome} stays distinct from unresolved`, async () => {
			const { prepared, workspace, paths } = prepareCase();
			createTeam(paths, "Correct the sample behavior", workspace);
			finishTeam(paths, "blocked", "No usable fix", ["Repair remains"]);
			const result = await evaluatePreparedBenchmark({ runDir: prepared.out_dir, taskId: paths.runId, modelConfig: "offline",
				evaluator: { async evaluate() { if (outcome === "infra_error") throw new Error("offline infrastructure failure"); return outcome; } },
			});
			expect(result.verdict).toBe(outcome);
			expect(result.task_status).toBe("blocked");
		});
	}
});
