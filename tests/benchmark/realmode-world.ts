/**
 * The offline real-mode world for the benchmark acceptance suite.
 *
 * Real mode (`benchmark run` WITHOUT `--fixture`) must drive: a spawned
 * Codeflow process per attempt, workspace provisioning at `base_commit`, the
 * official harness evaluator, and (for hub ids) dataset resolution. None of
 * that may touch the network in tests, so this builder assembles the
 * process-level fakes' inputs (tests/benchmark/fakes/README.md):
 *
 *  - a local bare "source clone" with two real commits whose shas become the
 *    instances' base_commits (so repo@base_commit is a real git fact, not a
 *    string comparison);
 *  - a pinned local snapshot (3 instances) and a hub snapshot (1 instance,
 *    distinct resolved revision) with evaluator-only CANARY payloads;
 *  - the scripted driver behavior and the fake harness verdicts;
 *  - an env factory wiring the four CODEFLOW_BENCHMARK_* seams to the fakes.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseEnv, makeTmpDir, REPO } from "./helpers";

export const FAKES_DIR = path.join(import.meta.dir, "fakes");
export const DRIVER_BIN = path.join(FAKES_DIR, "codeflow-driver.ts");
export const HARNESS_BIN = path.join(FAKES_DIR, "swebench-harness.ts");
export const CLONE_BIN = path.join(FAKES_DIR, "repo-clone.ts");
export const FETCH_BIN = path.join(FAKES_DIR, "dataset-fetch.ts");

/** The design-pinned dataset revision and harness commit (design §2). */
export const PINNED_REVISION = "78f471bf655a3137b2e8a75af1501690ec009ec3";
export const PINNED_HARNESS_COMMIT = "7a21e05772954cc81471ae19d56f436cecf43c54";
/** The distinct exact revision the fake hub resolution "resolves" to. */
export const RESOLVED_HUB_REVISION = "0123456789abcdef0123456789abcdef01234567";

export const INSTANCE_RESOLVED = "realmode/demo-2001";
export const INSTANCE_INFRA = "realmode/demo-2002";
export const INSTANCE_NOT_EVALUATED = "realmode/demo-2003";
export const INSTANCE_HUB = "realmode/hub-3001";

export interface RealmodeWorld {
	root: string;
	/** The local bare "dataset source clone" the fake clone command clones from. */
	sourceClone: string;
	/** sha256 of `git show-ref` (sorted) taken right after building the source. */
	sourceRefsDigest: string;
	snapshot: string;
	hubSnapshot: string;
	driverScript: string;
	harnessVerdicts: string;
	baseCommits: Record<string, string>;
	/** A fresh capture dir for one CLI run's fake invocations. */
	newCapture: () => string;
	/** Env wiring the four seams to the fakes; overrides per scenario. */
	env: (captureDir: string, overrides?: RealmodeEnvOverrides) => Record<string, string>;
}

export interface RealmodeEnvOverrides {
	driverMode?: "script" | "marathon" | "silent" | "stream";
	marathon?: { delayMs?: number; tokens?: number; tools?: number; maxRounds?: number };
	stream?: { delayMs?: number; rounds?: number; toolsPerRound?: number; tokens?: number };
	harnessMode?: "unavailable";
	fetchMode?: "alias";
	fetchSnapshot?: string;
	verdicts?: Record<string, string>;
	withoutHarness?: boolean;
}

function git(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args]);
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.toString()}`);
	}
	return result.stdout.toString().trim();
}

function sha256(text: string): string {
	return crypto.createHash("sha256").update(text).digest("hex");
}

/** Head + working-tree state digest, for "the checkout was not mutated" checks.
 * `.codeflow/` lines are ignored: the outer coordinator legitimately writes run
 * artifacts there while the suite executes — they are not benchmark mutations. */
export function snapshotGitState(dir: string): { head: string; statusDigest: string } {
	const status = git(dir, ["status", "--porcelain"])
		.split("\n")
		.filter((line) => line.length > 0 && !line.endsWith(".codeflow") && !line.includes(".codeflow/"))
		.sort()
		.join("\n");
	return { head: git(dir, ["rev-parse", "HEAD"]), statusDigest: sha256(status) };
}

function evaluatorOnlyFields(tag: string): Record<string, unknown> {
	return {
		patch: `diff --git a/f.py b/f.py\n--- a/f.py\n+++ b/f.py\nCANARY_GOLD_${tag}\n`,
		test_patch: `CANARY_TEST_PATCH_${tag}\n`,
		FAIL_TO_PASS: [`CANARY_F2P_${tag}`],
		PASS_TO_PASS: [`CANARY_P2P_${tag}`, `CANARY_P2P2_${tag}`],
		hints_text: `CANARY_HINT_${tag}`,
		assistant_notes: `CANARY_FUTURE_${tag}`, // unknown future dataset field
	};
}

function usage(input: number, output: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		input,
		output,
		reasoning: 0,
		cache_read: 0,
		cache_write: 0,
		total_tokens: input + output,
		cost: null,
		...extra,
	};
}

function round(
	role: string,
	provider: string,
	model: string,
	roundUsage: Record<string, unknown>,
	toolCalls: Array<{ call_id: string; tool: string; status: string }>,
	attribution: Record<string, string> = {},
): { type: "round"; round: Record<string, unknown> } {
	return {
		type: "round",
		round: { role, provider, model, ...attribution, usage: roundUsage, tool_calls: toolCalls },
	};
}

function workspaceWrite(file: string, content: string): { type: "workspace_write"; path: string; content: string } {
	return { type: "workspace_write", path: file, content };
}

/** Two real commits: baseOne (parent) and baseTwo (child) with distinct content. */
function buildSourceRepo(root: string): { bare: string; baseOne: string; baseTwo: string } {
	const work = path.join(root, "source-work");
	fs.mkdirSync(work, { recursive: true });
	git(work, ["init", "--quiet"]);
	git(work, ["branch", "-m", "main"]);
	const identity = ["-c", "user.name=benchmark-fixture", "-c", "user.email=fixture@codeflow.invalid"];
	fs.writeFileSync(path.join(work, "README.md"), "# realmode source repo\n", "utf8");
	fs.writeFileSync(path.join(work, "marker.txt"), "base-one\n", "utf8");
	git(work, [...identity, "add", "-A"]);
	git(work, [...identity, "commit", "--quiet", "-m", "base one"]);
	const baseOne = git(work, ["rev-parse", "HEAD"]);
	fs.writeFileSync(path.join(work, "marker.txt"), "base-one\nbase-two\n", "utf8");
	git(work, [...identity, "add", "-A"]);
	git(work, [...identity, "commit", "--quiet", "-m", "base two"]);
	const baseTwo = git(work, ["rev-parse", "HEAD"]);

	const bare = path.join(root, "source-clone", "realmode-repo.git");
	fs.mkdirSync(path.dirname(bare), { recursive: true });
	const clone = Bun.spawnSync(["git", "clone", "--quiet", "--bare", work, bare]);
	if (clone.exitCode !== 0) throw new Error(`bare clone failed: ${clone.stderr.toString()}`);
	fs.rmSync(work, { recursive: true, force: true });
	return { bare, baseOne, baseTwo };
}

export function buildRealmodeWorld(): RealmodeWorld {
	const root = makeTmpDir("codeflow-bench-realmode-");
	const { bare, baseOne, baseTwo } = buildSourceRepo(root);
	const baseCommits: Record<string, string> = {
		[INSTANCE_RESOLVED]: baseOne,
		[INSTANCE_INFRA]: baseTwo,
		[INSTANCE_NOT_EVALUATED]: baseTwo,
		[INSTANCE_HUB]: baseOne,
	};
	const sourceRefsDigest = sha256(git(bare, ["show-ref"]));

	function instance(id: string, problem: string): Record<string, unknown> {
		return {
			instance_id: id,
			repo: "realmode/realmode-repo",
			base_commit: baseCommits[id],
			problem_statement: problem,
			environment_setup_commit: baseCommits[id],
			created_at: "2026-08-19T00:00:00Z",
			version: "1.0",
			...evaluatorOnlyFields(id.split("/")[1].toUpperCase().replace(/-/g, "_")),
		};
	}

	const snapshot = {
		schema_version: 1,
		dataset_id: "SWE-bench/SWE-bench_Verified",
		split: "test",
		revision: PINNED_REVISION,
		harness_commit: PINNED_HARNESS_COMMIT,
		instances: [
			instance(INSTANCE_RESOLVED, "RM-2001: the resolved path must run a real process end to end."),
			instance(INSTANCE_INFRA, "RM-2002: infrastructure dies mid-attempt."),
			instance(INSTANCE_NOT_EVALUATED, "RM-2003: run fine, never graded."),
		],
	};
	const snapshotFile = path.join(root, "realmode-snapshot.json");
	fs.writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, "\t")}\n`, "utf8");

	const hubSnapshot = {
		...snapshot,
		revision: RESOLVED_HUB_REVISION,
		instances: [instance(INSTANCE_HUB, "RM-3001: hub-resolved dataset instance.")],
	};
	const hubSnapshotFile = path.join(root, "hub-snapshot.json");
	fs.writeFileSync(hubSnapshotFile, `${JSON.stringify(hubSnapshot, null, "\t")}\n`, "utf8");

	// Scripted driver behavior (see fakes/README.md): emit event -> sleep -> write.
	const driverScript = {
		instances: {
			[INSTANCE_RESOLVED]: {
				steps: [
					{
						event: round(
							"planner",
							"fake-anthropic",
							"fake-planner",
							usage(1000, 100, { reasoning: 20 }),
							[
								{ call_id: "c1", tool: "bash", status: "succeeded" },
								{ call_id: "c2", tool: "read", status: "succeeded" },
							],
						),
					},
					{
						event: round(
							"coder",
							"fake-openai",
							"fake-coder",
							usage(2000, 300, {
								cache_read: 900,
								cache_write: 100,
								total_tokens: 3300,
								cost: { input: 0.002, output: 0.001, cache_read: 0.0001, cache_write: 0.0002, total: 0.0033 },
							}),
							[
								{ call_id: "c3", tool: "write", status: "failed" },
								{ call_id: "c4", tool: "bash", status: "rejected" },
							],
							{ handoff_id: "h-2001", goal_id: "g-2001", lane: "main" },
						),
					},
					{
						event: {
							type: "failed_model_attempt",
							attempt: { role: "tester", provider: "fake-anthropic", model: "fake-tester", error_class: "provider_timeout" },
						},
					},
					{
						event: round(
							"verify",
							"fake-anthropic",
							"fake-verify",
							// cache_read/cache_write deliberately ABSENT: provider did not report.
							{ input: 400, output: 100, reasoning: 0, total_tokens: 500, cost: null },
							[{ call_id: "c5", tool: "bash", status: "incomplete" }],
						),
					},
					{ event: workspaceWrite("fix.py", "FIXED_RM_2001 = True\n") },
				],
			},
			[INSTANCE_INFRA]: {
				steps: [
					{
						event: round("coder", "fake-openai", "fake-coder", usage(600, 100), [
							{ call_id: "c1", tool: "bash", status: "succeeded" },
						]),
					},
					{ event: workspaceWrite("partial.py", "# partial 2002\n") },
					{ event: { type: "infra_error", error_class: "docker_daemon_unavailable" } },
				],
			},
			[INSTANCE_NOT_EVALUATED]: {
				steps: [
					{
						event: round("coder", "fake-openai", "fake-coder", usage(200, 100), [
							{ call_id: "c1", tool: "read", status: "succeeded" },
						]),
					},
				],
			},
			[INSTANCE_HUB]: {
				steps: [
					{
						event: round("coder", "fake-anthropic", "fake-hub", usage(150, 100), [
							{ call_id: "c1", tool: "bash", status: "succeeded" },
						]),
					},
					{ event: workspaceWrite("fix.py", "FIXED_RM_HUB_3001 = True\n") },
				],
			},
		},
	};
	const driverScriptFile = path.join(root, "driver-script.json");
	fs.writeFileSync(driverScriptFile, JSON.stringify(driverScript), "utf8");

	const verdicts = { [INSTANCE_RESOLVED]: "resolved", [INSTANCE_HUB]: "resolved" };
	const verdictsFile = path.join(root, "verdicts.json");
	fs.writeFileSync(verdictsFile, JSON.stringify(verdicts), "utf8");

	let captureCount = 0;
	const world: RealmodeWorld = {
		root,
		sourceClone: bare,
		sourceRefsDigest,
		snapshot: snapshotFile,
		hubSnapshot: hubSnapshotFile,
		driverScript: driverScriptFile,
		harnessVerdicts: verdictsFile,
		baseCommits,
		newCapture: () => {
			const dir = path.join(root, "captures", String(captureCount++));
			fs.mkdirSync(dir, { recursive: true });
			return dir;
		},
		env: (captureDir, overrides = {}) => {
			const env: Record<string, string> = {
				...baseEnv(),
				CODEFLOW_BENCHMARK_DRIVER_BIN: DRIVER_BIN,
				CODEFLOW_BENCHMARK_REPO_CLONE_BIN: CLONE_BIN,
				CODEFLOW_BENCHMARK_DATASET_FETCH_BIN: FETCH_BIN,
				FAKE_CAPTURE_DIR: captureDir,
				FAKE_DRIVER_SCRIPT: driverScriptFile,
				FAKE_CLONE_SOURCE: bare,
				FAKE_FETCH_SNAPSHOT: hubSnapshotFile,
				FAKE_HARNESS_VERDICTS: fs.readFileSync(verdictsFile, "utf8"),
			};
			if (!overrides.withoutHarness) env.CODEFLOW_BENCHMARK_HARNESS_BIN = HARNESS_BIN;
			if (overrides.driverMode) env.FAKE_DRIVER_MODE = overrides.driverMode;
			if (overrides.marathon) {
				if (overrides.marathon.delayMs !== undefined) env.FAKE_MARATHON_DELAY_MS = String(overrides.marathon.delayMs);
				if (overrides.marathon.tokens !== undefined) env.FAKE_MARATHON_TOKENS = String(overrides.marathon.tokens);
				if (overrides.marathon.tools !== undefined) env.FAKE_MARATHON_TOOLS = String(overrides.marathon.tools);
				if (overrides.marathon.maxRounds !== undefined) env.FAKE_MARATHON_MAX_ROUNDS = String(overrides.marathon.maxRounds);
			}
			if (overrides.stream) {
				if (overrides.stream.delayMs !== undefined) env.FAKE_STREAM_DELAY_MS = String(overrides.stream.delayMs);
				if (overrides.stream.rounds !== undefined) env.FAKE_STREAM_ROUNDS = String(overrides.stream.rounds);
				if (overrides.stream.toolsPerRound !== undefined) env.FAKE_STREAM_TOOLS_PER_ROUND = String(overrides.stream.toolsPerRound);
				if (overrides.stream.tokens !== undefined) env.FAKE_STREAM_TOKENS = String(overrides.stream.tokens);
			}
			if (overrides.harnessMode) env.FAKE_HARNESS_MODE = overrides.harnessMode;
			if (overrides.fetchMode) env.FAKE_FETCH_MODE = overrides.fetchMode;
			if (overrides.fetchSnapshot) env.FAKE_FETCH_SNAPSHOT = overrides.fetchSnapshot;
			if (overrides.verdicts) env.FAKE_HARNESS_VERDICTS = JSON.stringify(overrides.verdicts);
			return env;
		},
	};
	return world;
}

/** All fake-driver spawn captures in a capture dir, sorted by pid for stability. */
export function driverSpawns(captureDir: string): Array<Record<string, any>> {
	if (!fs.existsSync(captureDir)) return [];
	return fs
		.readdirSync(captureDir)
		.filter((name) => name.startsWith("driver-spawn-") && name.endsWith(".json"))
		.sort()
		.map((name) => JSON.parse(fs.readFileSync(path.join(captureDir, name), "utf8")));
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function codeflowCheckoutCommit(): string {
	return git(REPO, ["rev-parse", "HEAD"]);
}
