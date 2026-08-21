/**
 * Hub revision pinning (design §2): dataset row retrieval must be pinned to
 * the EXACT resolved 40-hex revision — for the FIRST rows request and EVERY
 * paginated follow-up — so revision resolution and row retrieval cannot race.
 *
 * These are business tests of the PRODUCTION fetch script
 * `benchmark/scripts/hub-fetch.ts` (the default behind the
 * CODEFLOW_BENCHMARK_DATASET_FETCH_BIN seam), exercised fully offline:
 *
 *  - the script must honor the offline datasets-server base
 *    CODEFLOW_BENCHMARK_HUB_SERVER_BASE, pointed at the in-process fake hub;
 *  - every `/rows` request — first page and each paginated follow-up — must
 *    carry the identical resolved 40-hex sha (never another state's sha, a
 *    short sha, or a movable alias such as main/latest);
 *  - a hub head that MOVES mid-pagination must not leak into any page;
 *  - the snapshot document / run manifest must record the 40-hex revision the
 *    rows actually used (never what was merely asked for).
 *
 * RED against the current implementation on purpose: today the script pins
 * neither — it ignores the offline bases (reaching for the real Hub, which
 * the dead-proxy guard below refuses instantly) and its `/rows` requests
 * omit the `revision` parameter entirely, so every paginated follow-up is
 * served from whatever the default branch's head is at that moment.
 *
 * No real network: all spawns route egress through an unroutable local proxy
 * with 127.0.0.1 exempted, so even a seam-ignoring implementation cannot
 * leave the host.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { baseEnv, cleanupTmpDirs, CODEFLOW_BIN, makeTmpDir, readJson, REPO } from "./helpers";
import { startFakeHub, type FakeHub, type FakeHubOptions } from "./fakes/hub-server";
import {
	buildRealmodeWorld,
	INSTANCE_HUB,
	INSTANCE_NOT_EVALUATED,
	INSTANCE_RESOLVED,
	PINNED_HARNESS_COMMIT,
	PINNED_REVISION,
	type RealmodeWorld,
} from "./realmode-world";

const HUB_FETCH_SCRIPT = path.join(REPO, "benchmark", "scripts", "hub-fetch.ts");
const HUB_ID = "SWE-bench/SWE-bench_Verified";
const SHA_40 = /^[0-9a-f]{40}$/;
/** A second, distinct, perfectly valid dataset state (the moved head). */
const MOVED_REVISION = "fedcba9876543210fedcba9876543210fedcba98";
/** An unroutable local proxy: any real-network egress fails in milliseconds. */
const DEAD_PROXY = "http://127.0.0.1:9";

/** Env pointing the production fetch script at the fake hub, with hard offline guard. */
function hubEnv(hub: FakeHub): Record<string, string> {
	return {
		...baseEnv(),
		CODEFLOW_BENCHMARK_HUB_SERVER_BASE: hub.serverBase,
		HTTPS_PROXY: DEAD_PROXY,
		https_proxy: DEAD_PROXY,
		HTTP_PROXY: DEAD_PROXY,
		http_proxy: DEAD_PROXY,
		NO_PROXY: "127.0.0.1,localhost",
		no_proxy: "127.0.0.1,localhost",
	};
}

/**
 * Spawn the production fetch script ASYNCHRONOUSLY: the in-process fake hub
 * serves on the event loop, which a synchronous spawn would block (the child
 * would hang waiting for a server that can never answer).
 */
async function runHubFetch(
	hub: FakeHub,
	hubId: string = HUB_ID,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const proc = Bun.spawn([process.execPath, HUB_FETCH_SCRIPT, hubId], {
		env: hubEnv(hub),
		stdout: "pipe",
		stderr: "pipe",
	});
	const killer = setTimeout(() => proc.kill(), 30_000);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(killer);
	return { exitCode, stdout, stderr };
}

async function withFakeHub<T>(options: FakeHubOptions, run: (hub: FakeHub) => T | Promise<T>): Promise<T> {
	const hub = startFakeHub(options);
	try {
		return await run(hub);
	} finally {
		hub.stop();
	}
}

/** Fail with the seam pointer instead of an opaque parse error. */
function requireFetchSuccess(result: {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}): void {
	if (result.exitCode !== 0) {
		throw new Error(
			`production hub-fetch failed against the offline fake hub (exit ${String(result.exitCode)}); it must honor ` +
				`CODEFLOW_BENCHMARK_HUB_SERVER_BASE and pin every /rows request ` +
					`to the design revision (tests/benchmark/fakes/README.md §5). stderr: ${result.stderr.slice(-400)}`,
		);
	}
}

/** Full-recipe rows for the design-fixed dataset, tagged by state for drift detection. */
function stateRows(state: string, count: number): Record<string, unknown>[] {
	return Array.from({ length: count }, (_, index) => ({
		instance_id: `demo/state-${state}-${String(index + 1).padStart(4, "0")}`,
		repo: "demo/repo",
		base_commit: `${state}${"0".repeat(39)}`.slice(0, 40),
		problem_statement: `state-${state} instance ${index + 1}: pinned pagination must fetch exactly this row.`,
		patch: `diff --git a/f.py b/f.py\n--- a/f.py\n+++ b/f.py\nGOLD_state_${state}_${index}\n`,
		test_patch: `TEST_PATCH_state_${state}_${index}\n`,
		FAIL_TO_PASS: [`F2P_state_${state}_${index}`],
		PASS_TO_PASS: [`P2P_state_${state}_${index}`],
		hints_text: `HINT_state_${state}_${index}`,
	}));
}

function stateIds(state: string, count: number): string[] {
	return stateRows(state, count).map((row) => row.instance_id as string);
}

/** The revision param every /rows request carried, in arrival order. */
function rowsRevisions(hub: FakeHub): string[] {
	return hub.rowsRequests().map((entry) => entry.query.revision ?? "");
}

describe("PIN-1: design dataset — the first rows request and EVERY paginated follow-up carry the identical pinned revision", () => {
	test("5 rows over 3 pages: each /rows request pinned to the design revision; document records it", async () => {
		await withFakeHub(
			{ datasetId: HUB_ID, states: [{ revision: PINNED_REVISION, rows: stateRows("a", 5) }], maxPageLength: 2 },
			async (hub) => {
				const result = await runHubFetch(hub);
				requireFetchSuccess(result);

				const document = JSON.parse(result.stdout);
				expect(document.schema_version).toBe(1);
				expect(document.dataset_id).toBe(HUB_ID);
				expect(document.split).toBe("test");
				expect(document.harness_commit).toBe(PINNED_HARNESS_COMMIT);
				// The document records the exact pinned 40-hex revision actually used.
				expect(document.revision).toBe(PINNED_REVISION);
				expect(SHA_40.test(document.revision)).toBe(true);
				expect(document.instances.map((instance: any) => instance.instance_id)).toEqual(stateIds("a", 5));

				// Pagination actually walked: 5 rows in pages of 2 → offsets 0, 2, 4.
				const rowsRequests = hub.rowsRequests();
				expect(rowsRequests.length).toBe(3);
				expect(rowsRequests.map((entry) => Number(entry.query.offset ?? "0"))).toEqual([0, 2, 4]);
				for (const entry of rowsRequests) {
					expect(entry.query.dataset).toBe(HUB_ID);
					expect(entry.query.split).toBe("test");
				}

				// THE pin: every page — first and follow-ups — carries the identical sha.
				const revisions = rowsRevisions(hub);
				expect(revisions.length).toBe(3);
				for (const revision of revisions) {
					expect(revision).toBe(PINNED_REVISION); // never another dataset state
					expect(SHA_40.test(revision)).toBe(true); // never a short sha
					expect(revision).not.toBe("main"); // never a movable alias
					expect(revision).not.toBe("latest");
				}
				expect(new Set(revisions).size).toBe(1); // identical across all pages
			},
		);
	});
});

describe("PIN-2: a hub head that MOVES mid-pagination cannot leak into any page", () => {
	test("head A→B after page 1: every /rows request still pinned to A; document carries only A's rows", async () => {
		await withFakeHub(
			{
				datasetId: HUB_ID,
				states: [
					{ revision: PINNED_REVISION, rows: stateRows("a", 3) },
					{ revision: MOVED_REVISION, rows: stateRows("b", 3) },
				],
				maxPageLength: 2,
				moveHeadAfterRowsRequests: { count: 1, toRevision: MOVED_REVISION },
			},
			async (hub) => {
				const result = await runHubFetch(hub);
				requireFetchSuccess(result);

				const rowsRequests = hub.rowsRequests();
				expect(rowsRequests.length).toBe(2); // 3 rows in pages of 2

				// Prove the race window was real: page 1 was served under head A,
				// page 2 was requested after the head had already moved to B.
				expect(rowsRequests[0].head).toBe(PINNED_REVISION);
				expect(rowsRequests[1].head).toBe(MOVED_REVISION);

				// An unpinned (or re-resolving) implementation silently follows the
				// moved head here; a pinned one asks for A on every page.
				for (const revision of rowsRevisions(hub)) {
					expect(revision).toBe(PINNED_REVISION);
				}
				expect(new Set(rowsRevisions(hub)).size).toBe(1);

				// No row from the moved state B may reach the document.
				const document = JSON.parse(result.stdout);
				expect(document.revision).toBe(PINNED_REVISION);
				expect(document.instances.map((instance: any) => instance.instance_id)).toEqual(stateIds("a", 3));
			},
		);
	});
});

describe("PIN-3: no alias or short sha may ever be requested or recorded", () => {
	test("every Hub request carrying a revision param carries the exact pinned 40-hex sha", async () => {
		await withFakeHub(
			{ datasetId: HUB_ID, states: [{ revision: PINNED_REVISION, rows: stateRows("a", 5) }], maxPageLength: 2 },
			async (hub) => {
				const result = await runHubFetch(hub);
				requireFetchSuccess(result);

				// Sweep ALL requests (splits + rows): after resolution, nothing may
				// ask the Hub for a movable alias or any other sha.
				const pinned = hub.requests.filter((entry) => entry.query.revision !== undefined);
				expect(pinned.length).toBeGreaterThanOrEqual(4); // ≥1 splits + 3 rows
				for (const entry of pinned) {
					expect(entry.query.revision).toBe(PINNED_REVISION);
					expect(entry.query.revision ?? "").toMatch(SHA_40);
				}
			},
		);
	});

	test("a movable default head cannot override the code-pinned revision", async () => {
		await withFakeHub(
			{
				datasetId: HUB_ID,
				states: [
					{ revision: "main", rows: stateRows("moving", 3) },
					{ revision: PINNED_REVISION, rows: stateRows("pinned", 3) },
				],
			},
			async (hub) => {
				const result = await runHubFetch(hub);
				requireFetchSuccess(result);
				expect(hub.requests.some((entry) => entry.path === `/api/datasets/${HUB_ID}`)).toBe(false);
				expect(rowsRevisions(hub).every((revision) => revision === PINNED_REVISION)).toBe(true);
				const document = JSON.parse(result.stdout);
				expect(document.revision).toBe(PINNED_REVISION);
				expect(document.instances.map((instance: any) => instance.instance_id)).toEqual(
					stateIds("pinned", 3),
				);
			},
		);
	});

	test("a different hub dataset id is rejected before any request", async () => {
		await withFakeHub({ datasetId: HUB_ID, states: [{ revision: PINNED_REVISION, rows: stateRows("a", 3) }] }, async (hub) => {
			const result = await runHubFetch(hub, "other/dataset");
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/design-pinned dataset/i);
			expect(result.stdout.trim()).toBe("");
			expect(hub.requests).toHaveLength(0);
		});
	});
});

/** Async CLI runner: like helpers.runCodeflow but Bun.spawn-based, so the
 * in-process fake hub can answer the CLI's production fetch child. */
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

describe("PIN-4: end to end — the run manifest records the 40-hex revision the rows actually used", () => {
	test("real CLI run on the PRODUCTION fetch default: manifest revision == the sha on every /rows request", async () => {
		const world: RealmodeWorld = buildRealmodeWorld();
		const rows = [INSTANCE_RESOLVED, INSTANCE_HUB, INSTANCE_NOT_EVALUATED].map((id, index) => ({
			instance_id: id,
			repo: "realmode/realmode-repo",
			base_commit: world.baseCommits[id],
			problem_statement: `PIN-4 instance ${index + 1}: fetched through pinned pagination.`,
			environment_setup_commit: world.baseCommits[id],
			created_at: "2026-08-19T00:00:00Z",
			version: "1.0",
			patch: `diff --git a/f.py b/f.py\n--- a/f.py\n+++ b/f.py\nCANARY_GOLD_PIN4_${index}\n`,
			test_patch: `CANARY_TEST_PATCH_PIN4_${index}\n`,
			FAIL_TO_PASS: [`CANARY_F2P_PIN4_${index}`],
			PASS_TO_PASS: [`CANARY_P2P_PIN4_${index}`],
			hints_text: `CANARY_HINT_PIN4_${index}`,
		}));

		await withFakeHub(
			{ datasetId: HUB_ID, states: [{ revision: PINNED_REVISION, rows }], maxPageLength: 2 },
			async (hub) => {
				const outDir = makeTmpDir("codeflow-bench-pin4-");
				const env = world.env(world.newCapture());
				// No fetch-seam override: the runner must fall back to the
				// PRODUCTION hub-fetch.ts, redirected to the fake hub.
				delete env.CODEFLOW_BENCHMARK_DATASET_FETCH_BIN;
				delete env.FAKE_FETCH_SNAPSHOT;
				delete env.FAKE_FETCH_MODE;
				Object.assign(env, hubEnv(hub));

				const result = await runCodeflowAsync(
					["benchmark", "run", "--dataset", HUB_ID, "--out", outDir],
					env,
					120_000,
				);
				if (result.exitCode !== 0) {
					throw new Error(
						`benchmark run with the production fetch default failed (exit ${String(result.exitCode)}): ` +
							`${result.stderr.slice(-500)}`,
					);
				}

				const manifest = readJson(path.join(outDir, "benchmark-run.json"));
				expect(manifest.dataset.dataset_id).toBe(HUB_ID);
				expect(manifest.dataset.split).toBe("test");
				expect(manifest.dataset.source).toBe("hub");
				expect(manifest.dataset.revision).toBe(PINNED_REVISION);
				expect(manifest.dataset.revision).toMatch(SHA_40); // never an alias or short sha
				expect(manifest.harness.commit).toBe(PINNED_HARNESS_COMMIT);

				// The run consumed pagination (3 rows in pages of 2 → 2 requests)...
				const revisions = rowsRevisions(hub);
				expect(revisions.length).toBe(2);
				// ...every page carried ONE identical sha...
				expect(new Set(revisions).size).toBe(1);
				// ...and the manifest records exactly that sha — what the rows
				// actually used, not what was merely asked for.
				expect(revisions[0]).toBe(manifest.dataset.revision);
				expect(readJson(path.join(outDir, "report.json")).comparison_keys.dataset_revision).toBe(
					PINNED_REVISION,
				);

				// The paginated rows really fed the run, in dataset order.
				expect(manifest.instances.selected).toEqual([
					INSTANCE_RESOLVED,
					INSTANCE_HUB,
					INSTANCE_NOT_EVALUATED,
				]);
			},
		);
	});
});

afterAll(cleanupTmpDirs);
