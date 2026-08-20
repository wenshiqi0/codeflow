/**
 * CLI surface: benchmark discoverability and argument contract, plus the
 * regression smoke for every pre-existing outer verb.
 *
 * Design §10: the capability must be discoverable through the existing
 * `codeflow` CLI. Design §13.1: unknown arguments fail with a stable
 * non-zero exit. Design §13.10: exec/resume/ls/sub/goals/usage/audit/stop
 * keep behaving.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseEnv, cleanupTmpDirs, makeTmpDir, runCodeflow } from "./helpers";

afterEach(cleanupTmpDirs);

const EXISTING_VERBS = ["exec", "resume", "ls", "sub", "goals", "usage", "audit", "stop"];

describe("benchmark CLI discoverability", () => {
	test("codeflow --help advertises the benchmark capability", () => {
		const result = runCodeflow(["--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("benchmark");
	});

	test("codeflow benchmark --help lists run and report", () => {
		const result = runCodeflow(["benchmark", "--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("run");
		expect(result.stdout).toContain("report");
	});

	test("codeflow benchmark run --help and report --help exit 0", () => {
		expect(runCodeflow(["benchmark", "run", "--help"]).exitCode).toBe(0);
		expect(runCodeflow(["benchmark", "report", "--help"]).exitCode).toBe(0);
	});
});

describe("benchmark CLI argument contract (stable non-zero exit 2)", () => {
	test("unknown benchmark subcommand fails with exit 2 and a named error", () => {
		const result = runCodeflow(["benchmark", "frobnicate"]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toMatch(/unknown (command|subcommand)/i);
		expect(result.stderr).toContain("frobnicate");
	});

	test("bare `codeflow benchmark` prints usage and fails", () => {
		const result = runCodeflow(["benchmark"]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toMatch(/usage/i);
	});

	test("unknown option for benchmark run fails with exit 2", () => {
		const result = runCodeflow(["benchmark", "run", "--bogus"]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toMatch(/unknown option/i);
		expect(result.stderr).toContain("--bogus");
	});

	test("unknown option for benchmark report fails with exit 2", () => {
		const result = runCodeflow(["benchmark", "report", "--bogus"]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toMatch(/unknown option/i);
	});

	test("benchmark run without --dataset fails with exit 2", () => {
		const result = runCodeflow(["benchmark", "run"]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toMatch(/--dataset/);
	});

	test("benchmark report without --run fails with exit 2", () => {
		const result = runCodeflow(["benchmark", "report"]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toMatch(/--run/);
	});

	test("malformed --budget value fails with exit 2, not a crash", () => {
		const result = runCodeflow([
			"benchmark",
			"run",
			"--dataset",
			"whatever",
			"--budget",
			"model-rounds=zero",
			"--fixture",
			"unused",
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toMatch(/budget/i);
	});

	test("unknown --budget name fails with exit 2", () => {
		const result = runCodeflow([
			"benchmark",
			"run",
			"--dataset",
			"whatever",
			"--budget",
			"dollars=100",
			"--fixture",
			"unused",
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toMatch(/budget/i);
	});
});

describe("existing outer verbs keep their contract (regression smoke)", () => {
	test("--help still lists every pre-existing verb", () => {
		const result = runCodeflow(["--help"]);
		expect(result.exitCode).toBe(0);
		for (const verb of EXISTING_VERBS) {
			expect(result.stdout).toContain(verb);
		}
	});

	test("ls works on an empty runs dir", () => {
		const runsDir = makeTmpDir("codeflow-bench-ls-");
		const result = runCodeflow(["ls"], { ...baseEnv(), CODEFLOW_RUNS_DIR: runsDir });
		expect(result.exitCode).toBe(0);
	});

	test("verbs that need a run id refuse without one (stable non-zero)", () => {
		const runsDir = makeTmpDir("codeflow-bench-args-");
		const env = { ...baseEnv(), CODEFLOW_RUNS_DIR: runsDir };
		for (const args of [
			["exec"],
			["resume"],
			["sub"],
			["goals"],
			["usage"],
			["stop"],
			["audit"],
		]) {
			const result = runCodeflow(args, env);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr.trim()).not.toBe("");
		}
	});

	test("unknown top-level verb still fails loudly", () => {
		const result = runCodeflow(["definitely-not-a-verb"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/unknown command/i);
	});
});
