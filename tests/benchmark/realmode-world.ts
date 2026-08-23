import * as fs from "node:fs";
import * as path from "node:path";
import { baseEnv, makeTmpDir } from "./helpers";

const FAKES_DIR = path.join(import.meta.dir, "fakes");
const DRIVER_BIN = path.join(FAKES_DIR, "codeflow-driver.ts");
const HARNESS_BIN = path.join(FAKES_DIR, "swebench-harness.ts");
const CLONE_BIN = path.join(FAKES_DIR, "repo-clone.ts");
const FETCH_BIN = path.join(FAKES_DIR, "dataset-fetch.ts");

export const PINNED_REVISION = "78f471bf655a3137b2e8a75af1501690ec009ec3";
export const PINNED_HARNESS_COMMIT = "7a21e05772954cc81471ae19d56f436cecf43c54";
export const RESOLVED_HUB_REVISION = "0123456789abcdef0123456789abcdef01234567";
export const INSTANCE_RESOLVED = "realmode/demo-2001";
export const INSTANCE_NOT_EVALUATED = "realmode/demo-2003";
export const INSTANCE_HUB = "realmode/hub-3001";

export interface RealmodeWorld {
	baseCommits: Record<string, string>;
	newCapture(): string;
	env(captureDir: string, overrides?: { fetchMode?: "alias" }): Record<string, string>;
}

function git(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args]);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

function buildSourceRepo(root: string): { bare: string; first: string; second: string } {
	const work = path.join(root, "source");
	fs.mkdirSync(work, { recursive: true });
	git(work, ["init", "--quiet"]);
	const identity = ["-c", "user.name=benchmark-fixture", "-c", "user.email=fixture@codeflow.invalid"];
	fs.writeFileSync(path.join(work, "marker.txt"), "first\n");
	git(work, [...identity, "add", "-A"]);
	git(work, [...identity, "commit", "--quiet", "-m", "first"]);
	const first = git(work, ["rev-parse", "HEAD"]);
	fs.writeFileSync(path.join(work, "marker.txt"), "second\n");
	git(work, [...identity, "add", "-A"]);
	git(work, [...identity, "commit", "--quiet", "-m", "second"]);
	const second = git(work, ["rev-parse", "HEAD"]);
	const bare = path.join(root, "source.git");
	const clone = Bun.spawnSync(["git", "clone", "--quiet", "--bare", work, bare]);
	if (clone.exitCode !== 0) throw new Error(clone.stderr.toString());
	return { bare, first, second };
}

function usage(): Record<string, unknown> {
	return { input: 90, output: 10, reasoning: 0, cache_read: 0, cache_write: 0, total_tokens: 100, cost: null };
}

export function buildRealmodeWorld(): RealmodeWorld {
	const root = makeTmpDir("codeflow-bench-realmode-");
	const source = buildSourceRepo(root);
	const baseCommits = {
		[INSTANCE_RESOLVED]: source.first,
		[INSTANCE_NOT_EVALUATED]: source.second,
		[INSTANCE_HUB]: source.first,
	};
	const instance = (id: string) => ({
		instance_id: id,
		repo: "realmode/realmode-repo",
		base_commit: baseCommits[id],
		problem_statement: `Resolve ${id}`,
		patch: `CANARY_GOLD_${id}`,
		test_patch: `CANARY_TEST_${id}`,
		FAIL_TO_PASS: [`CANARY_FAIL_${id}`],
		PASS_TO_PASS: [`CANARY_PASS_${id}`],
		hints_text: `CANARY_HINT_${id}`,
	});
	const hubSnapshot = path.join(root, "hub-snapshot.json");
	fs.writeFileSync(hubSnapshot, JSON.stringify({
		schema_version: 1,
		dataset_id: "SWE-bench/SWE-bench_Verified",
		split: "test",
		revision: RESOLVED_HUB_REVISION,
		harness_commit: PINNED_HARNESS_COMMIT,
		instances: [instance(INSTANCE_HUB)],
	}));
	const driverScript = path.join(root, "driver-script.json");
	const steps = (file?: string) => [
		{ event: { type: "round", round: { worker_kind: "worker", provider: "fake", model: "fake", usage: usage(), tool_calls: [] } } },
		...(file ? [{ write: { [file]: "FIXED = true\n" } }] : []),
	];
	fs.writeFileSync(driverScript, JSON.stringify({ instances: {
		[INSTANCE_RESOLVED]: { steps: steps("resolved.ts") },
		[INSTANCE_NOT_EVALUATED]: { steps: steps() },
		[INSTANCE_HUB]: { steps: steps("hub.ts") },
	} }));
	const verdicts = JSON.stringify({ [INSTANCE_RESOLVED]: "resolved", [INSTANCE_HUB]: "resolved" });
	let captures = 0;
	return {
		baseCommits,
		newCapture() {
			const directory = path.join(root, "captures", String(captures++));
			fs.mkdirSync(directory, { recursive: true });
			return directory;
		},
		env(captureDir, overrides = {}) {
			return {
				...baseEnv(),
				CODEFLOW_BENCHMARK_DRIVER_BIN: DRIVER_BIN,
				CODEFLOW_BENCHMARK_HARNESS_BIN: HARNESS_BIN,
				CODEFLOW_BENCHMARK_REPO_CLONE_BIN: CLONE_BIN,
				CODEFLOW_BENCHMARK_DATASET_FETCH_BIN: FETCH_BIN,
				FAKE_CAPTURE_DIR: captureDir,
				FAKE_DRIVER_SCRIPT: driverScript,
				FAKE_CLONE_SOURCE: source.bare,
				FAKE_FETCH_SNAPSHOT: hubSnapshot,
				FAKE_HARNESS_VERDICTS: verdicts,
				...(overrides.fetchMode ? { FAKE_FETCH_MODE: overrides.fetchMode } : {}),
			};
		},
	};
}
