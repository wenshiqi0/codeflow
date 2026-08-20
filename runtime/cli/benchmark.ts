#!/usr/bin/env bun
/**
 * `codeflow benchmark ...` — the SWE-bench Verified benchmark adapter
 * (design §10; product contract docs/benchmark-contract.md §2).
 *
 * Fixture/report/help paths are dispatched before credential loading; real
 * runs are dispatched after the normal CODEFLOW_HOME/.env load so configured
 * provider endpoints and keys reach the spawned Codeflow tree. Argument errors
 * exit 2 with `codeflow benchmark: error: ...` on stderr (a stable non-zero
 * code); unknown top-level verbs keep exiting 1 elsewhere.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { writeJsonAtomic } from "../lib/paths";
import {
	type BenchmarkBudgets,
	BenchmarkBudgetError,
	buildBenchmarkReport,
	createProcessCodeflowDriver,
	createProcessHarnessEvaluator,
	createSourceCloneWorkspaceProvisioner,
	loadFixtureDriver,
	newBenchmarkRunId,
	parseBudgetOverrides,
	readFixtureModelName,
	runBenchmark,
} from "../lib/benchmark";

const USAGE = `usage: codeflow benchmark <command> [options]

  run                               run a benchmark over the SWE-bench
                                    Verified dataset (default: real mode —
                                    a real Codeflow process per instance,
                                    repo@base_commit workspaces, and the
                                    official harness evaluator)
  report                            rebuild report.json from an existing
                                    benchmark run's artifacts

run options:
  --dataset <path|hub-id>           pinned local snapshot file or official
                                    dataset id (resolved to an exact revision)
  --instances <file>                instance allowlist: JSON array or
                                    newline-separated ids (dataset order wins)
  --pilot                           run the fixed 20-instance dev pilot
                                    (first 20 instances in dataset order)
  --out <dir>                       output dir
                                    (default .codeflow/benchmark/<run-id>)
  --concurrency <n>                 instance concurrency, default 1
  --budget <name>=<value>           repeatable override; name one of
                                    model-rounds|tool-calls|total-tokens|wall-seconds
  --model-config <id>               Codeflow model config id, default "default"
  --fixture <dir>                   offline fixture driver + evaluator +
                                    simulated clock (no model/docker/network)

real mode (no --fixture) spawns external commands; each has an
overrideable seam and a production default under runtime/scripts/benchmark:
  CODEFLOW_BENCHMARK_DRIVER_BIN       the Codeflow process
  CODEFLOW_BENCHMARK_REPO_CLONE_BIN   workspace provisioning at base_commit
  CODEFLOW_BENCHMARK_HARNESS_BIN      the official SWE-bench evaluator
  CODEFLOW_BENCHMARK_DATASET_FETCH_BIN hub dataset resolution

report options:
  --run <dir>                       benchmark output dir
  --out <file>                      report destination
                                    (default <run>/report.json)

  --help                            this usage
`;

function usageError(message: string): number {
	console.error(`codeflow benchmark: error: ${message}`);
	console.error(USAGE);
	return 2;
}

function runtimeError(message: string): number {
	console.error(`codeflow benchmark: error: ${message}`);
	return 1;
}

interface ParsedOption {
	name: string;
	value: string;
}

/** Known options per subcommand; a missing value or unknown option is an argument error. */
function parseOptions(
	argv: string[],
	known: readonly string[],
	allowPositional = false,
	valueless: readonly string[] = [],
): { options: ParsedOption[]; help: boolean; positional: string[] } | { error: string } {
	const options: ParsedOption[] = [];
	const positional: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (token === "--help" || token === "-h") return { options, help: true, positional };
		if (token.startsWith("--")) {
			if (!known.includes(token)) return { error: `unknown option: ${token}` };
			if (valueless.includes(token)) {
				options.push({ name: token, value: "true" });
				continue;
			}
			const value = argv[++index];
			if (value === undefined || value === "") return { error: `${token} requires a value` };
			options.push({ name: token, value });
			continue;
		}
		if (!allowPositional) return { error: `unexpected argument: ${token}` };
		positional.push(token);
	}
	return { options, help: false, positional };
}

function optionValue(options: ParsedOption[], name: string): string | undefined {
	return options.find((option) => option.name === name)?.value;
}

function optionValues(options: ParsedOption[], name: string): string[] {
	return options.filter((option) => option.name === name).map((option) => option.value);
}

/** JSON array or newline-separated ids; both are legal per contract. */
function readAllowlist(file: string): string[] {
	let content: string;
	try {
		content = fs.readFileSync(file, "utf8");
	} catch (error) {
		throw new BenchmarkBudgetError(`could not read --instances file ${file}: ${(error as Error).message}`);
	}
	const trimmed = content.trim();
	if (trimmed.startsWith("[")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			throw new BenchmarkBudgetError(`--instances file ${file} is not valid JSON: ${(error as Error).message}`);
		}
		if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) {
			throw new BenchmarkBudgetError(`--instances file ${file} must be a JSON array of instance ids`);
		}
		return parsed as string[];
	}
	const ids = content
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (ids.length === 0) {
		throw new BenchmarkBudgetError(`--instances file ${file} contains no instance ids`);
	}
	return ids;
}

const RUN_OPTIONS = [
	"--dataset",
	"--instances",
	"--out",
	"--concurrency",
	"--budget",
	"--model-config",
	"--fixture",
	"--pilot",
] as const;

const RUN_VALUELESS_OPTIONS = ["--pilot"] as const;

async function runCommand(argv: string[]): Promise<number> {
	const parsed = parseOptions(argv, RUN_OPTIONS, false, RUN_VALUELESS_OPTIONS);
	if ("error" in parsed) return usageError(parsed.error);
	if (parsed.help) {
		console.log(USAGE);
		return 0;
	}
	const options = parsed.options;

	const dataset = optionValue(options, "--dataset");
	if (dataset === undefined) return usageError("--dataset is required (pinned snapshot path or official dataset id)");

	// Argument validation completes before dataset/fixture resolution so a
	// malformed flag is reported as such even when the dataset path is wrong.
	let concurrency = 1;
	const concurrencyRaw = optionValue(options, "--concurrency");
	if (concurrencyRaw !== undefined) {
		const value = Number(concurrencyRaw);
		if (!Number.isInteger(value) || value < 1) {
			return usageError(`invalid --concurrency value: ${concurrencyRaw} (must be an integer >= 1)`);
		}
		concurrency = value;
	}
	let budgetOverrides: Partial<BenchmarkBudgets> | undefined;
	const budgetEntries = optionValues(options, "--budget");
	if (budgetEntries.length > 0) {
		try {
			budgetOverrides = parseBudgetOverrides(budgetEntries);
		} catch (error) {
			if (error instanceof BenchmarkBudgetError) return usageError(error.message);
			throw error;
		}
	}
	let allowlist: string[] | null = null;
	const instancesFile = optionValue(options, "--instances");
	if (instancesFile !== undefined) {
		try {
			allowlist = readAllowlist(instancesFile);
		} catch (error) {
			if (error instanceof BenchmarkBudgetError) return usageError(error.message);
			throw error;
		}
	}
	const modelConfig = optionValue(options, "--model-config") ?? "default";
	const pilot = options.some((option) => option.name === "--pilot");
	const fixtureDir = optionValue(options, "--fixture");

	try {
		const benchmarkRunId = newBenchmarkRunId();
		const outDir = optionValue(options, "--out") ?? path.resolve(".codeflow", "benchmark", benchmarkRunId);
		const shared = {
			dataset,
			instances: allowlist,
			outDir,
			budgets: budgetOverrides,
			concurrency,
			modelConfig,
			benchmarkRunId,
		};
		const result =
			fixtureDir !== undefined
				? await runBenchmark({
						...shared,
						// Offline fixture mode: scripted driver + fake evaluator +
						// deterministic simulated clock (contract §1.8).
						...loadFixtureRun(fixtureDir),
					})
				: await runRealMode({ ...shared, pilot });
		// Design §14: attempts without an official verdict are reported as
		// unexecuted external verification, never silently folded into the rate.
		const notEvaluated = result.report.counts.not_evaluated;
		if (notEvaluated > 0) {
			console.error(
				`codeflow benchmark: note: ${notEvaluated} attempt(s) have no official verdict ` +
					"(not_evaluated) — these results are unexecuted external verification and must not " +
					"be counted as resolved or unresolved (design §14).",
			);
		}
		console.log(
			JSON.stringify({
				benchmark_run_id: result.benchmarkRunId,
				out_dir: result.outDir,
				report: path.join(result.outDir, "report.json"),
				counts: result.report.counts,
				resolved_rate: result.report.resolved_rate,
			}),
		);
		return 0;
	} catch (error) {
		return runtimeError((error as Error).message);
	}
}

/** Fixture mode inputs for runBenchmark: driver, evaluator, clock, identity. */
function loadFixtureRun(fixtureDir: string): {
	driver: ReturnType<typeof loadFixtureDriver>["driver"];
	evaluator: ReturnType<typeof loadFixtureDriver>["evaluator"];
	clock: ReturnType<typeof loadFixtureDriver>["clock"];
	modelNameOrPath: string;
	driverMode: "fixture";
} {
	const fixture = loadFixtureDriver(fixtureDir);
	return {
		driver: fixture.driver,
		evaluator: fixture.evaluator,
		clock: fixture.clock,
		modelNameOrPath: readFixtureModelName(fixtureDir),
		driverMode: "fixture",
	};
}

/**
 * Real mode (the default): one spawned Codeflow process per instance attempt,
 * repo@base_commit workspaces via the clone seam, the official harness via the
 * harness seam, hub ids resolved via the fetch seam. Production defaults live
 * under runtime/scripts/benchmark (the live boundary); the four env seams let
 * the acceptance tests substitute process-level fakes offline.
 */
async function runRealMode(inputs: {
	dataset: string;
	instances: string[] | null;
	pilot: boolean;
	outDir: string;
	budgets: Partial<BenchmarkBudgets> | undefined;
	concurrency: number;
	modelConfig: string;
	benchmarkRunId: string;
}): Promise<ReturnType<typeof runBenchmark>> {
	return await runBenchmark({
		dataset: inputs.dataset,
		instances: inputs.instances,
		pilot: inputs.pilot,
		outDir: inputs.outDir,
		budgets: inputs.budgets,
		concurrency: inputs.concurrency,
		modelConfig: inputs.modelConfig,
		driver: createProcessCodeflowDriver(),
		evaluator: createProcessHarnessEvaluator(),
		workspaceProvisioner: createSourceCloneWorkspaceProvisioner(),
		benchmarkRunId: inputs.benchmarkRunId,
		modelNameOrPath: `codeflow:${inputs.modelConfig}`,
		driverMode: "codeflow",
	});
}

const REPORT_OPTIONS = ["--run", "--out"] as const;

function reportCommand(argv: string[]): number {
	const parsed = parseOptions(argv, REPORT_OPTIONS);
	if ("error" in parsed) return usageError(parsed.error);
	if (parsed.help) {
		console.log(USAGE);
		return 0;
	}
	const options = parsed.options;

	const runDir = optionValue(options, "--run");
	if (runDir === undefined) return usageError("--run is required (the benchmark output dir)");
	const out = optionValue(options, "--out") ?? path.join(runDir, "report.json");

	try {
		const report = buildBenchmarkReport(runDir);
		writeJsonAtomic(out, report);
		console.log(JSON.stringify({ report: out, counts: report.counts, resolved_rate: report.resolved_rate }));
		return 0;
	} catch (error) {
		return runtimeError((error as Error).message);
	}
}

export async function main(argv: string[]): Promise<number> {
	// runtime/bin/codeflow dispatches with the "benchmark" verb included.
	const args = argv[0] === "benchmark" ? argv.slice(1) : argv;
	const [command, ...rest] = args;
	switch (command) {
		case undefined:
		case "":
			return usageError("a subcommand is required: run | report");
		case "--help":
		case "-h":
		case "help":
			console.log(USAGE);
			return 0;
		case "run":
			return await runCommand(rest);
		case "report":
			return reportCommand(rest);
		default:
			console.error(`codeflow benchmark: error: unknown subcommand: ${command}`);
			console.error(USAGE);
			return 2;
	}
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
