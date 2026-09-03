import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const REPO = path.resolve(import.meta.dir, "..", "..");
export const CODEMARK_BIN = path.join(REPO, "runtime", "bin", "codemark");

const tmpDirs: string[] = [];

export function makeTmpDir(prefix = "codemark-test-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

export function cleanupTmpDirs(): void {
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

export function baseEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.CODEFLOW_RUN_ID;
	delete env.CODEFLOW_RUNS_DIR;
	delete env.CODEFLOW_GOAL_ID;
	delete env.CODEFLOW_EXECUTION_ID;
	delete env.CODEFLOW_COMMITMENT_ID;
	delete env.CODEMARK_RUN_ID;
	delete env.CODEMARK_RUN_DIR;
	delete env.CODEMARK_ISSUE;
	return env;
}

export function runCodemark(
	args: string[],
	options: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number } = {},
): { exitCode: number | null; stdout: string; stderr: string } {
	const spawned = Bun.spawnSync(["bash", CODEMARK_BIN, ...args], {
		cwd: options.cwd ?? REPO,
		env: options.env ?? baseEnv(),
		stdin: options.stdin === undefined ? undefined : Buffer.from(options.stdin),
		timeout: options.timeoutMs ?? 10_000,
	});
	return {
		exitCode: spawned.exitCode,
		stdout: spawned.stdout.toString(),
		stderr: spawned.stderr.toString(),
	};
}
