/**
 * Official evaluator wrapper contract — OFFLINE, pinned to the design-time
 * SWE-bench/SWE-bench harness commit 7a21e05772954cc81471ae19d56f436cecf43c54
 * (docs/benchmark-design.md §2, §9; docs/benchmark-contract.md §1.7).
 *
 * Subject: benchmark/scripts/swebench-harness.sh — the production
 * default behind CODEFLOW_BENCHMARK_HARNESS_BIN. Verdict authority is the
 * official evaluator (design §9): the wrapper may only translate what the
 * PINNED harness commit actually does, so every expected value here is
 * grounded in that commit's sources (asserted through
 * tests/benchmark/fakes/pinned-harness-logic.py, which mirrors them):
 *
 *  - swebench/harness/run_evaluation.py `__main__` argparse: -d/--dataset_name
 *    (DEFAULT "SWE-bench/SWE-bench_Lite" — so the wrapper MUST pass
 *    --dataset_name explicitly), -s/--split, -i/--instance_ids,
 *    -p/--predictions_path (required), --max_workers, --open_file_limit,
 *    -t/--timeout, -id/--run_id (required), --rewrite_reports, --report_dir,
 *    --modal. Unknown flags exit 2.
 *  - run_instance(): report at
 *    logs/run_evaluation/<run_id>/<model_name_or_path with "/"→"__">/<instance_id>/report.json
 *    (cwd-relative; RUN_EVALUATION_LOG_DIR = Path("logs/run_evaluation"),
 *    LOG_REPORT = "report.json" in swebench/harness/constants/__init__.py).
 *  - grading.get_eval_report(): per-instance report shape
 *    {"<instance_id>": {"resolved": <bool>, ...}}.
 *    The `resolved_ids`/`unresolved_ids` key sets belong to a DIFFERENT
 *    artifact — reporting.make_run_report()'s run-level
 *    <report_dir>/<model>.<run_id>.json — never to the per-instance report.
 *
 * Current wrong values these tests are red against (observed at authoring
 * time, to be fixed by the coder — never weaken these assertions to pass):
 *  - dataset default: "princeton-nlp/SWE-bench_Verified" instead of the
 *    design-pinned "SWE-bench/SWE-bench_Verified";
 *  - report path: logs/run_evaluation/<run_id>/<instance>/report.json —
 *    missing the model-name component, and parsed with run-level
 *    resolved_ids/unresolved_ids keys, so every completed evaluation would
 *    masquerade as not_evaluated.
 *
 * Fully offline: the wrapper's python3/docker are PATH stubs, the harness
 * checkout directory is pre-created (no clone), and a recording `git` stub
 * exits 99 — any accidental network attempt fails the test loudly. The
 * wrapper's own embedded verdict code runs under the real local python3
 * (the production wrapper itself requires python3).
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseEnv, cleanupTmpDirs, loadBenchmarkModule, makeTmpDir, REPO } from "./helpers";

afterEach(cleanupTmpDirs);

const WRAPPER = path.join(REPO, "benchmark", "scripts", "swebench-harness.sh");
const FAKES = path.join(REPO, "tests", "benchmark", "fakes");
const HARNESS_COMMIT = "7a21e05772954cc81471ae19d56f436cecf43c54";
const VERIFIED_DATASET = "SWE-bench/SWE-bench_Verified";
const INSTANCE_ID = "demo__demo-1";
const MODEL_NAME = "fixture/fake-model";
const MODEL_DIR = "fixture__fake-model"; // pinned run_instance(): "/" → "__"

/** The pinned commit's accepted long flags (swebench/harness/run_evaluation.py). */
const PINNED_LONG_FLAGS = new Set([
	"--dataset_name",
	"--split",
	"--instance_ids",
	"--predictions_path",
	"--max_workers",
	"--open_file_limit",
	"--timeout",
	"--run_id",
	"--rewrite_reports",
	"--report_dir",
	"--modal",
]);
/** Pinned short aliases -> long flag. */
const PINNED_SHORT_FLAGS = new Map<string, string>([
	["-d", "--dataset_name"],
	["-s", "--split"],
	["-i", "--instance_ids"],
	["-p", "--predictions_path"],
	["-t", "--timeout"],
	["-id", "--run_id"],
]);
/** Flags the pinned argparse marks required. */
const PINNED_REQUIRED_FLAGS = ["--predictions_path", "--run_id"];

interface WrapperWorld {
	/** The wrapper's harness cache; the pinned checkout is pre-created (no clone). */
	cacheDir: string;
	/** The pinned-commit checkout directory the harness must run from. */
	checkoutDir: string;
	/** Stub bin dir first on PATH: python3 stand-in, docker stub, recording git stub. */
	stubDir: string;
	/** Where the pinned-harness stand-in records invocations. */
	captureDir: string;
	/** Per-run scratch (predictions files). */
	outDir: string;
	runId: string;
}

function realPython3(): string {
	// Resolved from the TEST process's PATH (the stub dir only exists in the
	// spawned wrapper's environment), so this is a real interpreter.
	const found = Bun.which("python3");
	if (!found) {
		throw new Error(
			"python3 is required to behaviorally test the official-evaluator wrapper " +
				"(the production wrapper itself requires it; there is no offline substitute)",
		);
	}
	return found;
}

function buildWorld(): WrapperWorld {
	const root = makeTmpDir();
	const cacheDir = path.join(root, "cache");
	const checkoutDir = path.join(cacheDir, `SWE-bench-${HARNESS_COMMIT}`);
	fs.mkdirSync(checkoutDir, { recursive: true });
	const stubDir = path.join(root, "stub");
	fs.mkdirSync(stubDir, { recursive: true });
	const captureDir = path.join(root, "capture");
	fs.mkdirSync(captureDir, { recursive: true });
	const outDir = path.join(root, "out");
	fs.mkdirSync(outDir, { recursive: true });

	// `python3` resolves to the pinned-harness stand-in (fakes/README.md §7).
	fs.symlinkSync(path.join(FAKES, "pinned-harness-python3"), path.join(stubDir, "python3"));
	// docker: present and healthy — the wrapper's availability gate passes.
	fs.writeFileSync(path.join(stubDir, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	// git: any invocation (i.e. an attempted clone) is recorded and fails hard,
	// proving these tests never reach the network.
	fs.writeFileSync(
		path.join(stubDir, "git"),
		`#!/bin/sh\nmkdir -p "${captureDir}"\necho "git $*" >> "${captureDir}/git-calls.log"\nexit 99\n`,
		{ mode: 0o755 },
	);

	return { cacheDir, checkoutDir, stubDir, captureDir, outDir, runId: "" };
}

function wrapperEnv(
	world: WrapperWorld,
	extra: Record<string, string | undefined> = {},
): Record<string, string> {
	const env = baseEnv();
	delete env.CODEFLOW_BENCHMARK_EVAL_DATASET; // default-under-test must be the script's own
	env.PATH = `${world.stubDir}:${env.PATH ?? ""}`;
	env.CODEFLOW_BENCHMARK_HARNESS_CACHE = world.cacheDir;
	env.PINNED_HARNESS_REAL_PYTHON3 = realPython3();
	env.PINNED_HARNESS_LOGIC = path.join(FAKES, "pinned-harness-logic.py");
	env.PINNED_HARNESS_CAPTURE = world.captureDir;
	for (const [key, value] of Object.entries(extra)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return env;
}

function writePredictions(world: WrapperWorld, name: string, fields: Record<string, unknown>): string {
	const file = path.join(world.outDir, name);
	const lines = [JSON.stringify(fields)];
	fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
	return file;
}

interface WrapperResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	lastStdoutLine: string;
}

function runWrapper(
	world: WrapperWorld,
	args: { predictions: string; runId: string; instance: string },
	envExtra: Record<string, string | undefined> = {},
): WrapperResult {
	const spawned = Bun.spawnSync(
		[
			WRAPPER,
			"--predictions",
			args.predictions,
			"--run-id",
			args.runId,
			"--instance",
			args.instance,
		],
		{ env: wrapperEnv(world, envExtra), timeout: 60_000 },
	);
	const stdout = spawned.stdout.toString();
	const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
	return {
		exitCode: spawned.exitCode,
		stdout,
		stderr: spawned.stderr.toString(),
		lastStdoutLine: lines[lines.length - 1] ?? "",
	};
}

interface CaptureRow {
	cwd: string;
	argv: string[];
	flags: Record<string, unknown>;
	predictions: Record<string, unknown>[];
}

function readInvocations(world: WrapperWorld): CaptureRow[] {
	const file = path.join(world.captureDir, "invocations.jsonl");
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as CaptureRow);
}

/** argv (after `python3`) -> flag -> value, with pinned short flags normalized. */
function flagMap(argv: string[]): Map<string, string | string[]> {
	const map = new Map<string, string | string[]>();
	let i = 0;
	while (i < argv.length) {
		const token = argv[i];
		const long = PINNED_SHORT_FLAGS.get(token) ?? token;
		const next = argv[i + 1];
		if (long === "--instance_ids" && next !== undefined && !next.startsWith("-")) {
			const values: string[] = [];
			i += 1;
			while (i < argv.length && !argv[i].startsWith("-")) {
				values.push(argv[i]);
				i += 1;
			}
			map.set(long, values);
			continue;
		}
		if (next === undefined || next.startsWith("-")) {
			map.set(long, ""); // boolean flags take no value here
		} else {
			map.set(long, next);
			i += 2;
			continue;
		}
		i += 1;
	}
	return map;
}

function flag(map: Map<string, string | string[]>, name: string): string {
	const value = map.get(name);
	expect(typeof value).toBe("string");
	return value as string;
}

const EVAL_RUN_ID = `bench-20260819-120000-aaaa--${INSTANCE_ID}--a1`;

/* ------------------------------------------------------------------ *
 * WRAP-1 — the wrapper's default dataset id is the design-pinned one
 * ------------------------------------------------------------------ */

describe("official evaluator wrapper: dataset default (WRAP-1)", () => {
	test("WRAP-1a: without CODEFLOW_BENCHMARK_EVAL_DATASET the harness is told SWE-bench/SWE-bench_Verified", () => {
		const world = buildWorld();
		const predictions = writePredictions(world, "pred-wrap1.jsonl", {
			instance_id: INSTANCE_ID,
			model_name_or_path: MODEL_NAME,
			model_patch: "diff --git a/fix.py b/fix.py\n",
		});
		const result = runWrapper(world, {
			predictions,
			runId: EVAL_RUN_ID,
			instance: INSTANCE_ID,
		});
		expect(result.exitCode).toBe(0);
		const rows = readInvocations(world);
		expect(rows).toHaveLength(1);
		// RED today: the wrapper's default is the wrong id
		// "princeton-nlp/SWE-bench_Verified" (design §2 pins SWE-bench/...).
		expect(flag(flagMap(rows[0].argv.slice(2)), "--dataset_name")).toBe(VERIFIED_DATASET);
	});

	test("WRAP-1b: an explicit CODEFLOW_BENCHMARK_EVAL_DATASET override is still honored", () => {
		const world = buildWorld();
		const predictions = writePredictions(world, "pred-wrap1b.jsonl", {
			instance_id: INSTANCE_ID,
			model_name_or_path: MODEL_NAME,
			model_patch: "diff --git a/fix.py b/fix.py\n",
		});
		runWrapper(world, { predictions, runId: EVAL_RUN_ID, instance: INSTANCE_ID }, {
			CODEFLOW_BENCHMARK_EVAL_DATASET: "SWE-bench/SWE-bench_Lite",
		});
		const rows = readInvocations(world);
		expect(rows).toHaveLength(1);
		expect(flag(flagMap(rows[0].argv.slice(2)), "--dataset_name")).toBe("SWE-bench/SWE-bench_Lite");
	});
});

/* ------------------------------------------------------------------ *
 * WRAP-2 — the constructed CLI is the pinned commit's CLI
 * ------------------------------------------------------------------ */

describe("official evaluator wrapper: pinned-commit CLI contract (WRAP-2)", () => {
	test("WRAP-2: the invocation is `python3 -m swebench.harness.run_evaluation` with only flags that commit accepts", () => {
		const world = buildWorld();
		const predictions = writePredictions(world, "pred-wrap2.jsonl", {
			instance_id: INSTANCE_ID,
			model_name_or_path: MODEL_NAME,
			model_patch: "diff --git a/fix.py b/fix.py\n",
		});
		runWrapper(world, { predictions, runId: EVAL_RUN_ID, instance: INSTANCE_ID });
		const rows = readInvocations(world);
		expect(rows).toHaveLength(1);
		const row = rows[0];
		const argv = row.argv;

		// The module invocation the pinned commit exposes.
		expect(argv[0]).toBe("-m");
		expect(argv[1]).toBe("swebench.harness.run_evaluation");

		// Every flag is one the pinned argparse accepts (short forms normalized).
		const map = flagMap(argv.slice(2));
		for (const key of map.keys()) {
			expect(PINNED_LONG_FLAGS.has(key)).toBe(true);
		}
		// Flags that commit marks required are passed with values.
		for (const required of PINNED_REQUIRED_FLAGS) {
			expect(map.has(required)).toBe(true);
			expect(flag(map, required).length).toBeGreaterThan(0);
		}
		// The wrapper must pass --dataset_name explicitly: the pinned default
		// is SWE-bench/SWE-bench_Lite, never the Verified dataset.
		expect(map.has("--dataset_name")).toBe(true);
		expect(flag(map, "--dataset_name")).toBe(VERIFIED_DATASET);
		// The attempt protocol fixed by the seam contract: one instance, one run.
		expect(map.get("--instance_ids")).toEqual([INSTANCE_ID]);
		expect(flag(map, "--split")).toBe("test");
		expect(flag(map, "--predictions_path")).toBe(predictions);
		expect(Number.parseInt(flag(map, "--max_workers"), 10)).not.toBeNaN();
		expect(Number.parseInt(flag(map, "--timeout"), 10)).not.toBeNaN();
		// The pinned harness writes logs/run_evaluation relative to its CWD, so
		// the wrapper must invoke it from the pinned-commit checkout. Compare
		// canonical paths (python's getcwd resolves symlinked tmp roots).
		expect(fs.realpathSync(row.cwd)).toBe(fs.realpathSync(world.checkoutDir));
	});
});

/* ------------------------------------------------------------------ *
 * WRAP-3/4/5 — verdicts derive from the pinned report location + shape
 * ------------------------------------------------------------------ */

describe("official evaluator wrapper: pinned report location and shape (WRAP-3/4/5)", () => {
	test("WRAP-3: a run whose per-instance report says resolved=true yields `resolved`", () => {
		const world = buildWorld();
		const predictions = writePredictions(world, "pred-wrap3.jsonl", {
			instance_id: INSTANCE_ID,
			model_name_or_path: MODEL_NAME, // "/" exercises the pinned model-dir rewrite
			model_patch: "diff --git a/fix.py b/fix.py\n",
		});
		const result = runWrapper(world, {
			predictions,
			runId: EVAL_RUN_ID,
			instance: INSTANCE_ID,
		}, { PINNED_HARNESS_VERDICT: "resolved" });
		// The stand-in wrote the report where the pinned commit writes it:
		expect(
			fs.existsSync(
				path.join(world.checkoutDir, "logs", "run_evaluation", EVAL_RUN_ID, MODEL_DIR, INSTANCE_ID, "report.json"),
			),
		).toBe(true);
		// RED today: the wrapper reads logs/run_evaluation/<run_id>/<instance>/report.json
		// (no model-name component), so it prints not_evaluated.
		expect(result.exitCode).toBe(0);
		expect(result.lastStdoutLine).toBe("resolved");
	});

	test("WRAP-4: a run whose per-instance report says resolved=false yields `unresolved`", () => {
		const world = buildWorld();
		const predictions = writePredictions(world, "pred-wrap4.jsonl", {
			instance_id: INSTANCE_ID,
			model_name_or_path: MODEL_NAME,
			model_patch: "diff --git a/fix.py b/fix.py\n",
		});
		const result = runWrapper(world, {
			predictions,
			runId: EVAL_RUN_ID,
			instance: INSTANCE_ID,
		}, { PINNED_HARNESS_VERDICT: "unresolved" });
		// RED today (wrong path AND run-level resolved_ids parsing: not_evaluated).
		// Stays red against a path-only fix: the per-instance shape is keyed by
		// instance_id with a boolean "resolved", not resolved_ids lists.
		expect(result.exitCode).toBe(0);
		expect(result.lastStdoutLine).toBe("unresolved");
	});

	test("WRAP-5a: a harness infrastructure failure is `infra_error`, never unresolved, and is not retried", () => {
		const world = buildWorld();
		const predictions = writePredictions(world, "pred-wrap5a.jsonl", {
			instance_id: INSTANCE_ID,
			model_name_or_path: MODEL_NAME,
			model_patch: "diff --git a/fix.py b/fix.py\n",
		});
		const result = runWrapper(world, {
			predictions,
			runId: EVAL_RUN_ID,
			instance: INSTANCE_ID,
		}, { PINNED_HARNESS_FAIL: "1" });
		expect(result.exitCode).toBe(0);
		expect(result.lastStdoutLine).toBe("infra_error");
		// No silent in-wrapper retry: exactly one harness invocation.
		expect(readInvocations(world)).toHaveLength(1);
	});

	test("WRAP-5b: a completed run with no per-instance report is `not_evaluated`, never fabricated", () => {
		const world = buildWorld();
		const predictions = writePredictions(world, "pred-wrap5b.jsonl", {
			instance_id: INSTANCE_ID,
			model_name_or_path: MODEL_NAME,
			model_patch: "diff --git a/fix.py b/fix.py\n",
		});
		const result = runWrapper(world, {
			predictions,
			runId: EVAL_RUN_ID,
			instance: INSTANCE_ID,
		}, { PINNED_HARNESS_NO_REPORT: "1" });
		expect(result.exitCode).toBe(0);
		expect(result.lastStdoutLine).toBe("not_evaluated");
	});
});

/* ------------------------------------------------------------------ *
 * WRAP-6 — predictions stay consumable; attempts keep distinct run ids
 * ------------------------------------------------------------------ */

describe("official evaluator wrapper: predictions contract + distinct evaluation run ids (WRAP-6)", () => {
	test("WRAP-6a: a prediction the pinned harness cannot consume yields no fabricated verdict", () => {
		const world = buildWorld();
		// Boundary the pinned commit enforces: a missing model_patch means the
		// instance never runs and never gets a report (empty/error bucket).
		const predictions = writePredictions(world, "pred-wrap6a.jsonl", {
			instance_id: INSTANCE_ID,
			model_name_or_path: MODEL_NAME,
		});
		const result = runWrapper(world, {
			predictions,
			runId: EVAL_RUN_ID,
			instance: INSTANCE_ID,
		});
		expect(result.exitCode).toBe(0);
		expect(["not_evaluated", "infra_error"]).toContain(result.lastStdoutLine);
		expect(result.lastStdoutLine).not.toMatch(/^(resolved|unresolved)$/);
	});

	test("WRAP-6b: official-keys predictions grade per attempt under distinct evaluation run ids", async () => {
		const mod = await loadBenchmarkModule();
		const benchmarkRunId = "bench-20260819-120000-aaaa";
		const attempt1 = mod.newEvaluationRunId(benchmarkRunId, INSTANCE_ID, 1);
		const attempt2 = mod.newEvaluationRunId(benchmarkRunId, INSTANCE_ID, 2);
		expect(attempt1).not.toBe(attempt2); // harness cache is keyed by run_id + instance_id

		const world = buildWorld();
		const predictions = writePredictions(world, "pred-wrap6b.jsonl", {
			instance_id: INSTANCE_ID,
			model_name_or_path: MODEL_NAME,
			model_patch: "diff --git a/fix.py b/fix.py\n",
		});
		const first = runWrapper(world, { predictions, runId: attempt1, instance: INSTANCE_ID });
		const second = runWrapper(world, { predictions, runId: attempt2, instance: INSTANCE_ID });

		// Both attempts were handed to the harness under their own run id, and
		// the pinned layout gave each its own report tree (no cache collision).
		const rows = readInvocations(world);
		expect(rows).toHaveLength(2);
		expect(flag(flagMap(rows[0].argv.slice(2)), "--run_id")).toBe(attempt1);
		expect(flag(flagMap(rows[1].argv.slice(2)), "--run_id")).toBe(attempt2);
		for (const runId of [attempt1, attempt2]) {
			expect(
				fs.existsSync(
					path.join(world.checkoutDir, "logs", "run_evaluation", runId, MODEL_DIR, INSTANCE_ID, "report.json"),
				),
			).toBe(true);
		}
		// Each attempt's verdict comes from its own report (RED today: the
		// wrapper cannot find either, so both print not_evaluated).
		expect(first.exitCode).toBe(0);
		expect(first.lastStdoutLine).toBe("resolved");
		expect(second.exitCode).toBe(0);
		expect(second.lastStdoutLine).toBe("resolved");
	});
});

/* ------------------------------------------------------------------ *
 * Static floor — no process dependencies; pins the script text itself
 * ------------------------------------------------------------------ */

describe("official evaluator wrapper: static source contract", () => {
	const script = fs.readFileSync(WRAPPER, "utf8");

	test("S1: the script's dataset default literal is the design-pinned Verified id", () => {
		const match = script.match(/CODEFLOW_BENCHMARK_EVAL_DATASET:-([^}"']+)\}/);
		expect(match).not.toBeNull();
		// RED today: the literal is princeton-nlp/SWE-bench_Verified.
		expect(match?.[1]).toBe(VERIFIED_DATASET);
	});

	test("S2: the report path template carries the model-name component the pinned commit writes", () => {
		// Any quoted logs/run_evaluation/.../report.json template in the script.
		const templates = [
			...script.matchAll(/"([^"\n]*logs\/run_evaluation[^"\n]*report\.json)"/g),
		].map((match) => match[1]);
		expect(templates.length).toBeGreaterThanOrEqual(1);
		// RED today: the template is logs/run_evaluation/$run_id/$instance/report.json
		// (4 segments). The pinned run_instance() layout needs THREE dynamic
		// segments: <run_id>/<model_name_or_path '/'→'__'>/<instance_id>.
		const segments = templates[0].split("/");
		expect(segments).toHaveLength(6);
		expect(segments[0]).toBe("logs");
		expect(segments[1]).toBe("run_evaluation");
		expect(segments[5]).toBe("report.json");
		// The middle segment must be derived from the prediction's
		// model_name_or_path — so the script has to read that official field.
		expect(script).toMatch(/model_name_or_path/);
	});

	test("S3: verdict parsing reads the per-instance shape, never run-level resolved_ids lists", () => {
		// `resolved_ids`/`unresolved_ids` are keys of make_run_report()'s
		// run-level artifact (<report_dir>/<model>.<run_id>.json), which the
		// wrapper never reads; the per-instance report.json is keyed by
		// instance_id with a boolean `resolved`.
		expect(script).not.toMatch(/resolved_ids|unresolved_ids/);
		expect(script).toMatch(/resolved/);
	});
});
