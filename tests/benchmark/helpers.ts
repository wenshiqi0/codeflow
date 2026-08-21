/**
 * Shared harness for the benchmark acceptance suite.
 *
 * The benchmark capability does not exist yet (docs/benchmark-contract.md is
 * the contract; coder implements it). These tests must fail with a clear
 * contract message against the real CLI/module surface, never crash on
 * import — so the module is loaded dynamically and every CLI assertion goes
 * through the real `runtime/bin/codeflow` binary, exactly like tests/outer.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const REPO = path.resolve(import.meta.dir, "..", "..");
export const CODEFLOW_BIN = path.join(REPO, "runtime", "bin", "codeflow");
export const BENCHMARK_MODULE = path.join(REPO, "benchmark", "lib", "index.ts");
export const CONTRACT = "docs/benchmark-contract.md";
export const FIXTURES = path.join(import.meta.dir, "fixtures");
export const SNAPSHOT = path.join(FIXTURES, "verified-snapshot.json");
export const FIXTURE_DRIVER_DIR = FIXTURES;

/** The evaluator-only canary prefix; nothing under a benchmark out dir may contain it. */
export const CANARY_PREFIX = "CANARY_";

/**
 * This session runs inside a codeflow run, so CODEFLOW_RUN_ID is set in the
 * inherited environment. CLI tests must control the run variables themselves.
 */
export function baseEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.CODEFLOW_RUN_ID;
	delete env.CODEFLOW_RUNS_DIR;
	return env;
}

export interface CliResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export function runCodeflow(
	args: string[],
	env: Record<string, string> = baseEnv(),
	timeoutMs = 60_000,
): CliResult {
	const spawned = Bun.spawnSync(["bash", CODEFLOW_BIN, ...args], { env, timeout: timeoutMs });
	return {
		exitCode: spawned.exitCode,
		stdout: spawned.stdout.toString(),
		stderr: spawned.stderr.toString(),
	};
}

/**
 * Load the benchmark public module. When the module is missing or cannot be
 * imported, fail with the contract pointer instead of an opaque stack trace.
 */
export async function loadBenchmarkModule(): Promise<any> {
	const missing: string[] = [];
	if (!fs.existsSync(BENCHMARK_MODULE)) missing.push(BENCHMARK_MODULE);
	if (missing.length > 0) {
		throw new Error(
			`benchmark contract surface not implemented yet: ${missing.join(", ")}.\n` +
				`Implement the public API from ${CONTRACT}; these tests assert that contract.`,
		);
	}
	try {
		return await import(BENCHMARK_MODULE);
	} catch (error) {
		throw new Error(
			`benchmark module failed to import (${BENCHMARK_MODULE}); ` +
				`see ${CONTRACT} for the required public exports. Underlying error: ${String(error)}`,
		);
	}
}

const tmpDirs: string[] = [];

export function makeTmpDir(prefix = "codeflow-benchmark-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

export function cleanupTmpDirs(): void {
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Write an instance allowlist file: newline-separated ids (JSON array is also legal per contract). */
export function writeInstancesFile(ids: string[]): string {
	const file = path.join(makeTmpDir(), "instances.txt");
	fs.writeFileSync(file, `${ids.join("\n")}\n`, "utf8");
	return file;
}

export function readJson(file: string): any {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function readJsonl(file: string): any[] {
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

/** Recursively collect every file under a directory (relative paths). */
export function listFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else out.push(path.relative(root, full));
		}
	};
	walk(root);
	return out.sort();
}

/** caseDirName per the contract: instance_id with "/" -> "__". */
export function caseSlug(instanceId: string): string {
	return instanceId.replace(/\//g, "__");
}

export function casePath(outDir: string, instanceId: string): string {
	return path.join(outDir, "cases", caseSlug(instanceId));
}
