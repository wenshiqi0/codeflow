/**
 * Tool-network wall (design §4): benchmark mode must MECHANICALLY deny
 * outbound network access for Agent tool execution — in the ROOT role and in
 * DELEGATED roles — while the model-provider channel and the runner-side
 * infra channels (dataset fetch, evaluator invocation) stay separately
 * reachable under the same configuration.
 *
 * docs/benchmark-design.md §4: “Agent 工具不得使用外部网络检索答案… 模型
 * provider 所需网络与 Agent tool 网络必须在 manifest 中分开声明；正式结果
 * 默认记录为 tool_network: disabled”。 A manifest field or the driver prompt's
 * "do not use external network search" line is NOT enforcement; the denial
 * must be code-level and must cover the whole spawned Codeflow process tree.
 *
 * Mechanism scope (flagged in tests/benchmark/TESTPLAN.md and
 * fakes/README.md §6 — the SSOT leaves the mechanism open): whatever wall the
 * production driver puts around the spawned Codeflow run must be observable
 * by ORDINARY HTTP CLIENTS inheriting the spawned environment — a curl
 * subprocess and a bun/undici fetch, the two client families real tools use.
 * That is the only mechanism class that mechanically covers arbitrary tool
 * subprocesses of BOTH the root role and delegated-role children without
 * parsing tool arguments (design §12 disfavors shell parsing). A wall
 * implemented only as prompt text, or only as an in-process extension that
 * leaves the spawned environment untouched, does not pass these tests.
 *
 * Offline stand-ins (all loopback listeners, no real internet — see
 * fakes/net-recorder.ts):
 *
 *  - internet stand-in: `http://127.0.0.1:<port>/…` — NOT a configured
 *    provider endpoint; every outbound attempt from inside the walled tree
 *    must fail and the listener must record ZERO hits;
 *  - provider stand-in: `http://localhost:<port>/…`, wired as
 *    MEROUTER_BASE_URL (the runtime's env-configured provider seam) — must
 *    stay reachable from the SAME walled tree (the two networks of §4 are
 *    exempted separately);
 *  - evaluator upstream + fake Hub: runner-side channels that must stay
 *    reachable in the very same run whose agent tree is walled.
 *
 * RED on purpose where enforcement is missing: today nothing walls the tree,
 * so the internet stand-in IS reached and these tests fail. The control
 * cases (NET-C1/C2) run the same probes OUTSIDE benchmark mode and must
 * keep reaching the stand-in — proving the harness is valid and that
 * blocking is attributable to benchmark mode alone (no behavior change
 * outside it).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	baseEnv,
	cleanupTmpDirs,
	CODEFLOW_BIN,
	makeTmpDir,
	readJson,
	readJsonl,
	REPO,
	writeInstancesFile,
} from "./helpers";
import { startFakeHub } from "./fakes/hub-server";
import { startNetRecorder, type NetRecorder } from "./fakes/net-recorder";
import {
	buildRealmodeWorld,
	INSTANCE_RESOLVED,
	PINNED_REVISION,
	PINNED_HARNESS_COMMIT,
	type RealmodeWorld,
} from "./realmode-world";

const DRIVER_SCRIPT = path.join(REPO, "benchmark", "scripts", "codeflow-driver.ts");
const FAKE_INNER = path.join(REPO, "tests", "benchmark", "fakes", "inner-codeflow.sh");
const ROLE_NET_DRIVER = path.join(REPO, "tests", "benchmark", "fakes", "role-net-driver.ts");
const HUB_ID = "SWE-bench/SWE-bench_Verified";

const PROJECTION = {
	instance_id: "demo/netwall-1",
	repo: "demo/repo",
	base_commit: "a".repeat(40),
	problem_statement: "NETWALL problem statement marker",
};

/** Ambient proxy configuration would make reachability host-dependent. */
const PROXY_VARS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"http_proxy",
	"https_proxy",
	"NO_PROXY",
	"no_proxy",
	"ALL_PROXY",
	"all_proxy",
];

interface ProbeOutcome {
	exit?: number | null;
	reached: boolean;
}

interface RootProbe {
	internet_curl: ProbeOutcome;
	internet_fetch: ProbeOutcome;
	provider_curl: ProbeOutcome;
	provider_fetch: ProbeOutcome;
}

interface DelegatedProbe extends RootProbe {
	role: string | null;
	depth: string | null;
	prompt_head: string;
	error: string | null;
}

function wallDoc(): string {
	return (
		"docs/benchmark-design.md §4 requires benchmark mode to MECHANICALLY deny outbound network " +
		"for Agent tool execution (root AND delegated roles); a manifest field or the driver prompt's " +
		'"do not use external network search" line is not enforcement. The wall must be observable by ' +
		"ordinary HTTP clients inheriting the spawned environment — see tests/benchmark/fakes/README.md §6."
	);
}

/** Env for the production driver spawn: clean proxy baseline + probe wiring. */
function netEnv(
	internet: NetRecorder,
	provider: NetRecorder,
	capture: string,
	extra: Record<string, string> = {},
): Record<string, string> {
	const env = baseEnv();
	for (const key of PROXY_VARS) delete env[key];
	const providers = path.join(capture, "providers.json");
	fs.writeFileSync(
		providers,
		JSON.stringify({
			providers: {
				merouter: {
					name: "MeRouter",
					baseUrlEnv: "MEROUTER_BASE_URL",
					apiKeyEnv: "MEROUTER_API_KEY",
					api: "anthropic-messages",
					models: [{ id: "claude-opus-5", name: "Claude Opus 5" }],
				},
			},
		}),
		"utf8",
	);
	return {
		...env,
		CODEFLOW_BENCHMARK_CODEFLOW_BIN: FAKE_INNER,
		FAKE_INNER_MODE: "netprobe",
		FAKE_INNER_CAPTURE_DIR: capture,
		FAKE_ROLE_NET_CAPTURE: capture,
		NET_PROBE_URL: internet.url,
		NET_PROVIDER_URL: provider.url,
		NET_PROBE_BUN: process.execPath,
		NET_ROLE_NET_DRIVER: ROLE_NET_DRIVER,
		// The run's model-provider endpoint, through the runtime's existing
		// env-configured provider seam — the channel §4 exempts separately.
		MEROUTER_BASE_URL: provider.url.replace(/\/$/, ""),
		MEROUTER_API_KEY: "netwall-local-test-key",
		CODEFLOW_PROVIDER_PROFILES_PATH: providers,
		...extra,
	};
}

interface DriverRun {
	exitCode: number | null;
	capture: string;
}

/** Spawn the PRODUCTION driver with the netprobe inner fake; async so the
 * in-process recorders can answer the probes. */
async function runProductionDriverNetprobe(
	internet: NetRecorder,
	provider: NetRecorder,
	extra: Record<string, string> = {},
): Promise<DriverRun> {
	const capture = makeTmpDir("codeflow-bench-netwall-");
	const workspace = path.join(capture, "cases", "demo__netwall-1", "attempts", "1", "workspace");
	fs.mkdirSync(workspace, { recursive: true });

	const child = Bun.spawn(
		[process.execPath, DRIVER_SCRIPT, "--workspace", workspace, "--attempt", "1", "--model-config", "default"],
		{
			env: netEnv(internet, provider, capture, extra),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	child.stdin!.write(`${JSON.stringify(PROJECTION)}\n`);
	child.stdin!.end();
	const killer = setTimeout(() => child.kill(), 90_000);
	const stdoutText = new Response(child.stdout).text(); // drain so the driver never blocks on a full pipe
	const exitCode = await child.exited;
	clearTimeout(killer);
	await stdoutText.catch(() => undefined);
	return { exitCode, capture };
}

function rootProbe(capture: string): RootProbe {
	const file = path.join(capture, "netprobe-root.json");
	if (!fs.existsSync(file)) throw new Error(`netprobe-root.json missing under ${capture}: the inner probe never ran`);
	return readJson(file);
}

function delegatedProbe(capture: string): DelegatedProbe {
	const file = path.join(capture, "delegated-probe.json");
	if (!fs.existsSync(file)) throw new Error(`delegated-probe.json missing under ${capture}: the delegated-role probe never ran`);
	return readJson(file);
}

function delegatedRun(capture: string): { success: boolean; exitCode: number; content_head: string; stderr_head: string } {
	const file = path.join(capture, "delegated-run.json");
	if (!fs.existsSync(file)) throw new Error(`delegated-run.json missing under ${capture}: the real role launcher never completed`);
	return readJson(file);
}

interface SharedRun {
	internet: NetRecorder;
	provider: NetRecorder;
	driver: DriverRun;
}

let shared: SharedRun;
let world: RealmodeWorld;

beforeAll(async () => {
	world = buildRealmodeWorld();
	const internet = startNetRecorder("internet");
	const provider = startNetRecorder("provider");
	// One shared production-driver run feeds NET-1/2/3 (root probes, provider
	// channel, delegated chain all live in the same spawned tree).
	const driver = await runProductionDriverNetprobe(internet, provider);
	shared = { internet, provider, driver };
}, 120_000);

afterAll(() => {
	shared?.internet.stop();
	shared?.provider.stop();
	cleanupTmpDirs();
});

describe("NET-1/2/3: the production driver's spawned Codeflow tree", () => {
	test("NET-1: root-role tool egress is mechanically BLOCKED (curl AND fetch); the internet stand-in records zero hits", () => {
		expect(shared.driver.exitCode).toBe(0); // the wall must not break the attempt
		const root = rootProbe(shared.driver.capture);

		// THE wall assertions: real outbound attempts from inside the tree fail.
		if (root.internet_curl.reached) throw new Error(`curl reached the internet stand-in from the root role. ${wallDoc()}`);
		if (root.internet_fetch.reached) throw new Error(`bun fetch reached the internet stand-in from the root role. ${wallDoc()}`);

		// No leak at all: the listener itself saw nothing from the walled tree.
		expect(shared.internet.hits).toHaveLength(0);
	});

	test("NET-2: the model-provider endpoint stays reachable from the SAME walled tree (separate network, design §4)", () => {
		const root = rootProbe(shared.driver.capture);
		if (!root.provider_curl.reached) {
			throw new Error(
				`curl could NOT reach the provider stand-in (MEROUTER_BASE_URL) from the walled tree — the wall ` +
					`must exempt the run's configured provider endpoints separately from tool network. ${wallDoc()}`,
			);
		}
		if (!root.provider_fetch.reached) {
			throw new Error(`bun fetch could not reach the provider stand-in from the walled tree. ${wallDoc()}`);
		}
		expect(shared.provider.paths()).toContain("/root");
	});

	test("NET-3: delegated-role tool egress is blocked through the REAL role-launcher chain; provider still reachable; delegation machinery unharmed", () => {
		const run = delegatedRun(shared.driver.capture);
		expect(run.success).toBe(true); // the wall must not break role delegation itself
		expect(run.content_head).toContain("netwall delegated probe complete");

		const probe = delegatedProbe(shared.driver.capture);
		// The probe really was the delegated-role child of the real launcher.
		expect(probe.role).toBe("coder");
		expect(probe.depth).toBe("1");
		expect(probe.prompt_head.length).toBeGreaterThan(0);
		expect(probe.error).toBeNull();

		if (probe.internet_curl.reached) throw new Error(`curl reached the internet stand-in from a DELEGATED role child. ${wallDoc()}`);
		if (probe.internet_fetch.reached) throw new Error(`bun fetch reached the internet stand-in from a DELEGATED role child. ${wallDoc()}`);
		if (!probe.provider_curl.reached || !probe.provider_fetch.reached) {
			throw new Error(`the provider stand-in is unreachable from the delegated role child. ${wallDoc()}`);
		}

		// Zero delegated-path leaks on the listener, ever.
		expect(shared.internet.paths().filter((p) => p.includes("delegated"))).toHaveLength(0);
		expect(shared.provider.paths()).toContain("/delegated");
	});
});

describe("controls: the same probes OUTSIDE benchmark mode must still reach the stand-ins", () => {
	test("NET-C1: root probe without the benchmark driver reaches the internet stand-in (harness validity; no behavior change outside benchmark mode)", async () => {
		const internet = startNetRecorder("internet");
		const provider = startNetRecorder("provider");
		const capture = makeTmpDir("codeflow-bench-netwall-c1-");
		try {
			// Spawn the inner fake DIRECTLY (no production driver, no benchmark
			// env) — exactly where it runs inside the tree, but unwalled.
			const child = Bun.spawn(["bash", FAKE_INNER, "exec", "NETWALL control root probe"], {
				env: netEnv(internet, provider, capture, { NET_SKIP_DELEGATED: "1" }),
				stdout: "ignore",
				stderr: "inherit",
			});
			const killer = setTimeout(() => child.kill(), 60_000);
			const exitCode = await child.exited;
			clearTimeout(killer);
			expect(exitCode).toBe(0);

			const root = rootProbe(capture);
			if (!root.internet_curl.reached || !root.internet_fetch.reached) {
				throw new Error(
					"control failed: outside benchmark mode the internet stand-in must be reachable — " +
						"a failure here means the probe/listener harness is broken, not that the wall works",
				);
			}
			expect(internet.paths()).toContain("/root");
			expect(root.provider_curl.reached).toBe(true);
		} finally {
			internet.stop();
			provider.stop();
		}
	}, 90_000);

	test("NET-C2: delegated probe without benchmark env reaches the internet stand-in through the real role-launcher", async () => {
		const internet = startNetRecorder("internet");
		const provider = startNetRecorder("provider");
		const capture = makeTmpDir("codeflow-bench-netwall-c2-");
		try {
			const child = Bun.spawn([process.execPath, ROLE_NET_DRIVER], {
				env: netEnv(internet, provider, capture),
				stdout: "ignore",
				stderr: "inherit",
			});
			const killer = setTimeout(() => child.kill(), 60_000);
			const exitCode = await child.exited;
			clearTimeout(killer);
			expect(exitCode).toBe(0);

			const run = delegatedRun(capture);
			expect(run.success).toBe(true);
			const probe = delegatedProbe(capture);
			if (!probe.internet_curl.reached) {
				throw new Error(
					"control failed: outside benchmark mode the delegated-role child must reach the " +
						"internet stand-in — benchmark mode must be the ONLY thing that walls it",
				);
			}
			expect(internet.paths()).toContain("/delegated");
		} finally {
			internet.stop();
			provider.stop();
		}
	}, 90_000);
});

async function runCodeflowAsync(
	args: string[],
	env: Record<string, string>,
	timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["bash", CODEFLOW_BIN, ...args], { env, stdout: "pipe", stderr: "pipe" });
	const killer = setTimeout(() => proc.kill(), timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(killer);
	return { exitCode, stdout, stderr };
}

describe("NET-5: one benchmark run — infra channels open while the agent tree is walled; manifest separates the networks", () => {
	test("real CLI run: dataset fetch + evaluator upstream reachable, agent tree blocked, tool_network/provider network declared separately", async () => {
		const internet = startNetRecorder("internet");
		const provider = startNetRecorder("provider");
		const evaluator = startNetRecorder("evaluator");
		const hub = startFakeHub({
			datasetId: HUB_ID,
			states: [
				{
					revision: PINNED_REVISION,
					rows: [
						{
							instance_id: INSTANCE_RESOLVED,
							repo: "realmode/realmode-repo",
							base_commit: world.baseCommits[INSTANCE_RESOLVED],
							problem_statement: "NET-5: one benchmark run, walled tree, open infra channels.",
							environment_setup_commit: world.baseCommits[INSTANCE_RESOLVED],
							created_at: "2026-08-19T00:00:00Z",
							version: "1.0",
							patch: "diff --git a/f.py b/f.py\n--- a/f.py\n+++ b/f.py\nCANARY_GOLD_NET5\n",
							test_patch: "CANARY_TEST_PATCH_NET5\n",
							FAIL_TO_PASS: ["CANARY_F2P_NET5"],
							PASS_TO_PASS: ["CANARY_P2P_NET5"],
							hints_text: "CANARY_HINT_NET5",
						},
					],
				},
			],
		});

		const capture = world.newCapture();
		const outDir = makeTmpDir("codeflow-bench-netwall-e2e-");
		try {
			const env = world.env(capture);
			// Everything real except the two live boundaries the host cannot
			// serve offline: the PRODUCTION driver runs (seam NOT overridden)
			// with the inner `codeflow` binary faked as the netprobe; the
			// PRODUCTION dataset fetch runs against the fake Hub.
			delete env.CODEFLOW_BENCHMARK_DRIVER_BIN;
			delete env.CODEFLOW_BENCHMARK_DATASET_FETCH_BIN;
			delete env.FAKE_FETCH_SNAPSHOT;
			delete env.FAKE_FETCH_MODE;
			env.CODEFLOW_BENCHMARK_HUB_SERVER_BASE = hub.serverBase;
			env.FAKE_HARNESS_NET_URL = `${evaluator.url}evaluator-upstream`;
			for (const [key, value] of Object.entries(netEnv(internet, provider, capture))) {
				env[key] = value;
			}

			const result = await runCodeflowAsync(
				[
					"benchmark", "run",
					"--dataset", HUB_ID,
					"--instances", writeInstancesFile([INSTANCE_RESOLVED]),
					"--out", outDir,
				],
				env,
				150_000,
			);
			if (result.exitCode !== 0) {
				throw new Error(`benchmark run failed (exit ${String(result.exitCode)}): ${result.stderr.slice(-600)}`);
			}

			// (a) The agent tree was walled inside THIS run: root + delegated
			// probes failed their outbound attempts and nothing leaked.
			const root = rootProbe(capture);
			if (root.internet_curl.reached || root.internet_fetch.reached) {
				throw new Error(`root-role egress leaked in the full run. ${wallDoc()}`);
			}
			const probe = delegatedProbe(capture);
			if (probe.internet_curl.reached || probe.internet_fetch.reached) {
				throw new Error(`delegated-role egress leaked in the full run. ${wallDoc()}`);
			}
			expect(internet.hits).toHaveLength(0);

			// (b) The provider channel stayed open from the same walled tree...
			expect(root.provider_curl.reached).toBe(true);
			expect(probe.provider_fetch.reached).toBe(true);
			expect(provider.paths()).toContain("/root");
			expect(provider.paths()).toContain("/delegated");
			// ...and the runner-side infra channels reached their listeners:
			// dataset fetch through the production hub-fetch (pinned rows), and
			// the evaluator invocation through the fake harness's upstream check.
			expect(hub.rowsRequests().length).toBeGreaterThanOrEqual(1);
			const harnessCalls = readJsonl(path.join(capture, "harness-calls.jsonl"));
			expect(harnessCalls).toHaveLength(1);
			expect(harnessCalls[0].net_check.ok).toBe(true);
			expect(evaluator.paths()).toContain("/evaluator-upstream");

			// (c) The manifest declares the two networks SEPARATELY.
			const manifest = readJson(path.join(outDir, "benchmark-run.json"));
			expect(Object.keys(manifest)).toContain("tool_network");
			expect(Object.keys(manifest)).toContain("model_provider_network");
			expect(manifest.tool_network).toBe("disabled"); // tool network: denied
			expect(manifest.model_provider_network).toBe("required"); // provider network: open
			expect(manifest.dataset.source).toBe("hub");
			expect(manifest.dataset.revision).toBe(PINNED_REVISION);
			expect(manifest.harness.commit).toBe(PINNED_HARNESS_COMMIT);
			const report = readJson(path.join(outDir, "report.json"));
			expect(report.comparison_keys.tool_network).toBe("disabled");

			// The attempt itself completed and was graded (a wall is not an error).
			const slug = INSTANCE_RESOLVED.replace(/\//g, "__");
			const attempt = readJson(path.join(outDir, "cases", slug, "case.json")).attempts[0];
			expect(attempt.execution_status).toBe("completed");
			expect(attempt.verdict).toBe("resolved");
		} finally {
			internet.stop();
			provider.stop();
			evaluator.stop();
			hub.stop();
		}
	}, 180_000);
});
