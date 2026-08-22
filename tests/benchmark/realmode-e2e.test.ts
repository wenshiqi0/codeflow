/**
 * Real-mode (non-fixture) end-to-end acceptance — the path
 * docs/benchmark-design.md §4 actually describes: a real Codeflow process per
 * instance attempt in a fresh repo@base_commit workspace, real usage/tool-call
 * instrumentation feeding the ledgers, the official harness evaluator invoked
 * with unique evaluation run ids, and verdicts merged into the report.
 *
 * Everything runs offline through the process-level fakes defined in
 * tests/benchmark/fakes/README.md: the runner spawns the fake driver/clone/
 * harness/fetch executables via the four CODEFLOW_BENCHMARK_* env seams. No
 * network, no Docker, no model, no `.codeflow/runs/` transcript reads.
 *
 * RED against the current milestone on purpose: `benchmark run` without
 * `--fixture` currently refuses with "only --fixture mode is implemented".
 * Fixture-only acceptance must not pass as product completion (design §13.2
 * covers the chain, §14 forbids fixture results standing in for real mode).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	CANARY_PREFIX,
	casePath,
	cleanupTmpDirs,
	listFiles,
	loadBenchmarkModule,
	readJson,
	readJsonl,
	runCodeflow,
	writeInstancesFile,
} from "./helpers";
import {
	buildRealmodeWorld,
	codeflowCheckoutCommit,
	driverSpawns,
	INSTANCE_INFRA,
	INSTANCE_NOT_EVALUATED,
	INSTANCE_RESOLVED,
	PINNED_HARNESS_COMMIT,
	PINNED_REVISION,
	snapshotGitState,
	type RealmodeWorld,
} from "./realmode-world";

let world: RealmodeWorld;
let outDir: string;
let captureDir: string;
let runResult: ReturnType<typeof runCodeflow>;
let repoBefore: { head: string; statusDigest: string };

function realmodeRun(dir: string, extra: string[] = []): ReturnType<typeof runCodeflow> {
	return runCodeflow(
		["benchmark", "run", "--dataset", world.snapshot, "--out", dir, ...extra],
		world.env(captureDir),
		90_000,
	);
}

function artifact(rel: string): string {
	const full = path.join(outDir, rel);
	if (!fs.existsSync(full)) {
		throw new Error(
			`missing ${rel}: the real-mode benchmark run failed (exit ${runResult.exitCode}) — ` +
				`stderr: ${runResult.stderr.slice(0, 500)}`,
		);
	}
	return full;
}

function attemptOf(id: string): any {
	return readJson(artifact(path.join("cases", id.replace(/\//g, "__"), "case.json"))).attempts[0];
}

function harnessRows(capture: string = captureDir): any[] {
	const file = path.join(capture, "harness-calls.jsonl");
	return fs.existsSync(file) ? readJsonl(file) : [];
}

beforeAll(() => {
	world = buildRealmodeWorld();
	repoBefore = snapshotGitState(path.resolve(import.meta.dir, "..", ".."));
	outDir = path.join(world.root, "out");
	captureDir = world.newCapture();
	runResult = realmodeRun(outDir);
}, 150_000);

afterAll(cleanupTmpDirs);

describe("REAL-1: non-fixture run with a pinned local snapshot completes offline", () => {
	test("exit 0 — real mode is a first-class path, not fixture-only", () => {
		expect(runResult.stderr).not.toMatch(/only --fixture mode is implemented/);
		expect(runResult.exitCode).toBe(0);
	});

	test("the full artifact set exists, including per-attempt workspaces", () => {
		for (const rel of [
			"benchmark-run.json",
			"predictions.jsonl",
			"report.json",
			`cases/${INSTANCE_RESOLVED.replace(/\//g, "__")}/case.json`,
			`cases/${INSTANCE_RESOLVED.replace(/\//g, "__")}/attempts/1/usage.jsonl`,
			`cases/${INSTANCE_RESOLVED.replace(/\//g, "__")}/attempts/1/tool-calls.jsonl`,
			`cases/${INSTANCE_RESOLVED.replace(/\//g, "__")}/attempts/1/failed-model-attempts.jsonl`,
			`cases/${INSTANCE_RESOLVED.replace(/\//g, "__")}/attempts/1/workspace/fix.py`,
			`cases/${INSTANCE_INFRA.replace(/\//g, "__")}/attempts/1/workspace/partial.py`,
		]) {
			expect(fs.existsSync(path.join(outDir, rel))).toBe(true);
		}
	});
});

describe("REAL-2: the manifest pins what actually ran in real mode", () => {
	test("dataset identity, exact revision, pinned harness commit, codeflow commit", () => {
		const manifest = readJson(artifact("benchmark-run.json"));
		expect(manifest.dataset.dataset_id).toBe("SWE-bench/SWE-bench_Verified");
		expect(manifest.dataset.split).toBe("test");
		expect(manifest.dataset.revision).toBe(PINNED_REVISION);
		expect(manifest.dataset.source).toBe("local-snapshot");
		expect(manifest.harness.commit).toBe(PINNED_HARNESS_COMMIT);
		expect(manifest.codeflow_commit).toBe(codeflowCheckoutCommit());
		expect(manifest.codeflow_commit).toMatch(/^[0-9a-f]{40}$/);
	});

	test("driver mode and network declarations say codeflow/required, not fixture", () => {
		const manifest = readJson(artifact("benchmark-run.json"));
		expect(manifest.driver_mode).toBe("codeflow");
		// The two networks are SEPARATE fields with INDEPENDENT values (design
		// §4): real mode needs the provider network while tool network stays
		// denied — one must never be derived from the other.
		expect(Object.keys(manifest)).toContain("tool_network");
		expect(Object.keys(manifest)).toContain("model_provider_network");
		expect(manifest.model_provider_network).toBe("required");
		expect(manifest.tool_network).toBe("disabled");
		expect(manifest.concurrency).toBe(1);
		expect(manifest.instances.selected).toEqual([INSTANCE_RESOLVED, INSTANCE_INFRA, INSTANCE_NOT_EVALUATED]);
	});

	test("real mode loads CODEFLOW_HOME/.env before spawning the benchmark driver", () => {
		const home = path.join(world.root, "benchmark-codeflow-home");
		const capture = world.newCapture();
		const output = path.join(world.root, "out-env-load");
		fs.mkdirSync(home, { recursive: true });
		fs.writeFileSync(path.join(home, ".env"), "CODEFLOW_BENCHMARK_ENV_MARKER=loaded-before-driver\n", "utf8");
		const env = world.env(capture);
		env.CODEFLOW_HOME = home;
		delete env.CODEFLOW_BENCHMARK_ENV_MARKER;
		const result = runCodeflow(
			[
				"benchmark", "run",
				"--dataset", world.snapshot,
				"--instances", writeInstancesFile([INSTANCE_RESOLVED]),
				"--out", output,
			],
			env,
			90_000,
		);
		expect(result.exitCode).toBe(0);
		const spawn = driverSpawns(capture)[0];
		expect(spawn.env.CODEFLOW_BENCHMARK_ENV_MARKER).toBe("loaded-before-driver");
	});
});

describe("REAL-3: workspaces are fresh repo@base_commit; sources stay unmutated", () => {
	test("the driver process started on a workspace whose HEAD is the instance's base_commit", () => {
		const spawns = driverSpawns(captureDir);
		expect(spawns.length).toBe(3); // one process per instance attempt
		for (const spawn of spawns) {
			const instance = JSON.parse(spawn.stdin);
			expect(spawn.workspace_head).toBe(world.baseCommits[instance.instance_id]);
		}
	});

	test("each workspace holds the base commit's content and only driver-written changes", () => {
		const workspaceOf = (id: string) =>
			path.join(casePath(outDir, id), "attempts", "1", "workspace");
		// base-one content at the parent commit...
		expect(fs.readFileSync(path.join(workspaceOf(INSTANCE_RESOLVED), "marker.txt"), "utf8")).toBe("base-one\n");
		// ...and base-two content at the child commit: a real checkout, not a string.
		expect(fs.readFileSync(path.join(workspaceOf(INSTANCE_INFRA), "marker.txt"), "utf8")).toBe(
			"base-one\nbase-two\n",
		);
		expect(fs.readFileSync(path.join(workspaceOf(INSTANCE_RESOLVED), "fix.py"), "utf8")).toContain(
			"FIXED_RM_2001",
		);
	});

	test("the dataset source clone and the Codeflow checkout are not mutated", () => {
		const refs = Bun.spawnSync(["git", "-C", world.sourceClone, "show-ref"]).stdout
			.toString()
			.trim();
		expect(createHash("sha256").update(refs).digest("hex")).toBe(world.sourceRefsDigest);
		const repoAfter = snapshotGitState(path.resolve(import.meta.dir, "..", ".."));
		expect(repoAfter.head).toBe(repoBefore.head);
		expect(repoAfter.statusDigest).toBe(repoBefore.statusDigest);
	});
});

describe("REAL-4: the spawned process saw only the allowlist projection", () => {
	test("driver stdin is exactly the four model-visible fields", () => {
		const spawns = driverSpawns(captureDir);
		expect(spawns.length).toBe(3); // never vacuous: no driver ran => loud failure
		for (const spawn of spawns) {
			const instance = JSON.parse(spawn.stdin);
			expect(Object.keys(instance).sort()).toEqual([
				"base_commit",
				"instance_id",
				"problem_statement",
				"repo",
			]);
		}
	});

	test("no evaluator-only canary reaches the driver, its environment, or any artifact", () => {
		const spawns = driverSpawns(captureDir);
		expect(spawns.length).toBe(3);
		for (const spawn of spawns) {
			expect(`${spawn.argv.join(" ")}\n${spawn.stdin}`).not.toContain(CANARY_PREFIX);
			expect(JSON.stringify(spawn.env)).not.toContain(CANARY_PREFIX);
		}
		const files = listFiles(outDir);
		expect(files.filter((rel) => rel.endsWith(".json") || rel.endsWith(".jsonl")).length).toBeGreaterThan(0);
		for (const rel of listFiles(outDir)) {
			if (rel.endsWith(".tmp")) continue;
			const content = fs.readFileSync(path.join(outDir, rel), "utf8");
			expect(`${rel}:${content}`).not.toContain(CANARY_PREFIX);
		}
	});
});

describe("REAL-5: usage instrumentation from the real process feeds the ledger", () => {
	test("one usage row per completed round, with role/provider/model/goal attribution", () => {
		const rows = readJsonl(
			artifact(path.join("cases", INSTANCE_RESOLVED.replace(/\//g, "__"), "attempts", "1", "usage.jsonl")),
		);
		expect(rows).toHaveLength(3);
		expect(rows.map((r: any) => r.role)).toEqual(["planner", "coder", "verify"]);
		expect(rows.map((r: any) => `${r.provider}/${r.model}`)).toEqual([
			"fake-anthropic/fake-planner",
			"fake-openai/fake-coder",
			"fake-anthropic/fake-verify",
		]);
		expect(rows[1].handoff_id).toBe("h-2001");
		expect(rows[1].goal_id).toBe("g-2001");
		expect(rows[1].lane).toBe("main");
		for (const row of rows) expect(row.schema_version).toBe(2);
	});

	test("failed provider attempts are recorded separately, never as rounds", () => {
		const failed = readJsonl(
			artifact(path.join("cases", INSTANCE_RESOLVED.replace(/\//g, "__"), "attempts", "1", "failed-model-attempts.jsonl")),
		);
		expect(failed).toHaveLength(1);
		expect(failed[0].error_class).toBe("provider_timeout");
		expect(failed[0].role).toBe("tester");
		expect(Object.keys(failed[0]).sort()).toEqual(["at", "error_class", "model", "provider", "role", "schema_version"]);
		const metrics = attemptOf(INSTANCE_RESOLVED).metrics;
		expect(metrics.model_rounds_total).toBe(3);
		expect(metrics.failed_model_attempts).toBe(1);
	});
});

describe("REAL-6: tool-call ledger from the real process", () => {
	test("statuses cover succeeded/failed/rejected/incomplete for one multi-call response", () => {
		const metrics = attemptOf(INSTANCE_RESOLVED).metrics;
		expect(metrics.tool_calls_total).toBe(5); // 2 + 2 + 1 calls for 3 rounds
		expect(metrics.tool_call_counts).toEqual({
			requested: 5,
			completed: 4,
			succeeded: 2,
			failed: 1,
			rejected: 1,
			incomplete: 1,
		});
		expect(metrics.tool_calls_by_tool).toEqual({ bash: 3, read: 1, write: 1 });
	});

	test("ledger rows carry ids/names/status/attribution only — no params, results, or command text", async () => {
		const rows = readJsonl(
			artifact(path.join("cases", INSTANCE_RESOLVED.replace(/\//g, "__"), "attempts", "1", "tool-calls.jsonl")),
		);
		expect(rows.length).toBeGreaterThan(0);
		// The allowed key set IS the module's contract constant (design §7:
		// id/name/status/timestamps/attribution, where attribution includes
		// role AND provider/model + goal/lane) — the same SSOT ATTR-1 pins, so
		// this row can never drift behind a contract change again.
		const bench = await loadBenchmarkModule();
		const allowed = new Set<string>([...bench.TOOL_CALL_RECORD_FIELDS]);
		for (const row of rows) {
			for (const key of Object.keys(row)) expect(allowed.has(key)).toBe(true);
		}
		for (const row of rows) {
			expect(JSON.stringify(row)).not.toContain("FIXED_RM_2001");
			expect(row.tool).toMatch(/^(bash|read|write)$/);
		}
	});
});

describe("REAL-7: the report aggregates the real-mode run honestly", () => {
	const report = () => readJson(artifact("report.json"));

	test("every classification visible; denominator is valid official verdicts only", () => {
		expect(report().counts).toEqual({
			instances: 3,
			attempts: 3,
			resolved: 1,
			unresolved: 0,
			infra_error: 1,
			not_evaluated: 1,
		});
		expect(report().resolved_rate).toBe(1);
		expect(report().resolved_rate_denominator).toBe(1);
	});

	test("per-resolved numerators include infra_error and not_evaluated attempts", () => {
		expect(report().model_rounds).toMatchObject({ total: 5, primary: 4, support: 1, failed_attempts: 1 });
		expect(report().per_resolved.rounds).toBe(5);
		expect(report().per_resolved.tool_calls).toBe(7);
		expect(report().per_resolved.tokens).toBe(5900);
		expect(report().tool_calls_per_model_round).toBeCloseTo(7 / 5, 12);
	});

	test("cache: unreported round poisons availability; sums stay token-true", () => {
		expect(report().cache).toEqual({
			read: 900,
			write: 100,
			fresh_input_tokens: 4200,
			prompt_tokens: 5200,
			hit_rate: null,
			metrics_available: false,
			per_attempt_hit_rate: { median: 0, p90: 0 },
			fresh_tokens: null,
		});
	});

	test("budgets terminated nobody in this run; breakdowns attribute by model", () => {
		expect(report().budget_terminations).toEqual({
			model_rounds: 0, tool_calls: 0, total_tokens: 0, wall_seconds: 0, none: 3,
			fresh_tokens: 0,
		});
		expect(report().breakdowns.by_model["fake-openai/fake-coder"]).toEqual({
			model_rounds: 3,
			tool_calls: 4,
			total_tokens: 4300,
		});
		expect(report().breakdowns.by_tool).toEqual({ bash: 4, read: 2, write: 1 });
		expect(report().comparison_keys.dataset_revision).toBe(PINNED_REVISION);
	});
});

describe("REAL-8: verdict merge and the harness invocation contract", () => {
	test("resolved and not_evaluated came from the harness; infra_error never reached it", () => {
		expect(attemptOf(INSTANCE_RESOLVED).verdict).toBe("resolved");
		expect(attemptOf(INSTANCE_NOT_EVALUATED).verdict).toBe("not_evaluated");
		const infra = attemptOf(INSTANCE_INFRA);
		expect(infra.verdict).toBe("infra_error");
		expect(infra.execution_status).toBe("infra_error");

		const rows = harnessRows();
		expect(rows).toHaveLength(2);
		expect(rows.some((r: any) => r.instance === INSTANCE_INFRA)).toBe(false);
		for (const row of rows) expect(row.official_fields_ok).toBe(true);
	});

	test("the unique evaluation run id actually reached the official harness", () => {
		const manifest = readJson(artifact("benchmark-run.json"));
		const resolved = attemptOf(INSTANCE_RESOLVED);
		expect(resolved.evaluation_run_id).toBe(
			`${manifest.benchmark_run_id}--${INSTANCE_RESOLVED.replace(/\//g, "__")}--a1`,
		);
		const row = harnessRows().find((r: any) => r.instance === INSTANCE_RESOLVED);
		expect(row?.run_id).toBe(resolved.evaluation_run_id);
	});
});

describe("REAL-9: predictions carry official fields and extracted patches", () => {
	test("one line per attempt in dataset order, exactly three official keys", () => {
		const predictions = readJsonl(artifact("predictions.jsonl"));
		expect(predictions.map((p: any) => p.instance_id)).toEqual([
			INSTANCE_RESOLVED,
			INSTANCE_INFRA,
			INSTANCE_NOT_EVALUATED,
		]);
		for (const p of predictions) {
			expect(Object.keys(p).sort()).toEqual(["instance_id", "model_name_or_path", "model_patch"]);
			expect(typeof p.model_name_or_path).toBe("string");
			expect(p.model_name_or_path.length).toBeGreaterThan(0);
		}
	});

	test("patches are the workspace diffs, including the partial patch after an infra stop", () => {
		const byId = Object.fromEntries(readJsonl(artifact("predictions.jsonl")).map((p: any) => [p.instance_id, p]));
		expect(byId[INSTANCE_RESOLVED].model_patch).toContain("FIXED_RM_2001");
		expect(byId[INSTANCE_INFRA].model_patch).toContain("# partial 2002");
		expect(byId[INSTANCE_NOT_EVALUATED].model_patch).toBe("");
	});
});

describe("REAL-10: a re-run cannot reuse the first run's evaluation cache", () => {
	test("a second run of the same instance gets a different evaluation run id", () => {
		const first = attemptOf(INSTANCE_RESOLVED).evaluation_run_id;
		const dir = path.join(world.root, "out-second");
		const capture = world.newCapture();
		const result = runCodeflow(
			[
				"benchmark", "run",
				"--dataset", world.snapshot,
				"--instances", writeInstancesFile([INSTANCE_RESOLVED]),
				"--out", dir,
			],
			world.env(capture),
			90_000,
		);
		expect(result.exitCode).toBe(0);
		const second = readJson(path.join(dir, "cases", INSTANCE_RESOLVED.replace(/\//g, "__"), "case.json"))
			.attempts[0].evaluation_run_id;
		expect(second).not.toBe(first);
	});
});

describe("REAL-11: report rebuild re-invokes nothing", () => {
	test("benchmark report restores identical aggregates without driver or harness", () => {
		const before = readJson(artifact("report.json"));
		const spawnsBefore = driverSpawns(captureDir).length;
		const harnessBefore = harnessRows().length;
		fs.rmSync(path.join(outDir, "report.json"));
		const result = runCodeflow(["benchmark", "report", "--run", outDir]);
		expect(result.exitCode).toBe(0);
		const after = readJson(artifact("report.json"));
		expect(after.counts).toEqual(before.counts);
		expect(after.resolved_rate).toEqual(before.resolved_rate);
		expect(after.per_resolved).toEqual(before.per_resolved);
		expect(after.budget_terminations).toEqual(before.budget_terminations);
		expect(driverSpawns(captureDir).length).toBe(spawnsBefore);
		expect(harnessRows().length).toBe(harnessBefore);
	});
});

describe("REAL-12: an unavailable evaluator is reported, never fabricated", () => {
	test("evaluator cannot run ⇒ not_evaluated + explicit unexecuted external verification", () => {
		const dir = path.join(world.root, "out-unavailable");
		const capture = world.newCapture();
		const result = runCodeflow(
			[
				"benchmark", "run",
				"--dataset", world.snapshot,
				"--instances", writeInstancesFile([INSTANCE_RESOLVED]),
				"--out", dir,
			],
			world.env(capture, { harnessMode: "unavailable" }),
			90_000,
		);
		expect(result.exitCode).toBe(0);
		const attempt = readJson(
			path.join(dir, "cases", INSTANCE_RESOLVED.replace(/\//g, "__"), "case.json"),
		).attempts[0];
		expect(attempt.verdict).toBe("not_evaluated");
		expect(attempt.execution_status).toBe("completed"); // the run itself finished
		const report = readJson(path.join(dir, "report.json"));
		expect(report.counts.not_evaluated).toBe(1);
		expect(report.counts.resolved).toBe(0);
		// Design §14: explicit unexecuted external verification, never silence.
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/external verification/i);
	});
});
