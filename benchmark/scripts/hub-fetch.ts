#!/usr/bin/env bun
/**
 * Production default for CODEFLOW_BENCHMARK_DATASET_FETCH_BIN (the seam
 * contract in tests/benchmark/fakes/README.md §4).
 *
 *   <this> <hub-id>
 *
 * Prints exactly one complete snapshot JSON document (benchmark contract
 * §1.1) on stdout: the dataset id, split `test`, the EXACT pinned 40-hex
 * design-pinned dataset revision, the design-pinned harness commit, and the
 * full instance records (evaluator-only
 * fields included — the loader's allowlist projection keeps them away from
 * models).
 *
 * Live boundary: this is the only code path that talks to the HuggingFace
 * datasets server for the fixed Verified snapshot.
 * It is exercised only in live runs, never in the offline acceptance suite.
 * Failures are loud and non-zero; a movable alias can never be printed
 * because only a 40-hex sha is accepted as the revision.
 *
 * Race-free by construction (design §2): the code-pinned sha is sent on
 * /splits and the first /rows page and EVERY paginated follow-up. The current
 * default-branch head is never consulted, so runs made on different dates
 * cannot silently select different benchmark data.
 *
 * Offline seam (tests/benchmark/fakes/README.md §5): the datasets-server base
 * is overridable through CODEFLOW_BENCHMARK_HUB_SERVER_BASE so the pinning
 * tests can drive this exact script against the in-process fake Hub.
 */

export {};

const SPLIT = "test";
const PINNED_DATASET_ID = "SWE-bench/SWE-bench_Verified";
const PINNED_DATASET_REVISION = "78f471bf655a3137b2e8a75af1501690ec009ec3";
const PINNED_HARNESS_COMMIT = "7a21e05772954cc81471ae19d56f436cecf43c54";
const PAGE_SIZE = 100;
/** Datasets-server base (splits + every rows page). Overridable for offline tests. */
const HUB_SERVER_BASE = (
	process.env.CODEFLOW_BENCHMARK_HUB_SERVER_BASE ?? "https://datasets-server.huggingface.co"
).replace(/\/+$/, "");

function fail(message: string): never {
	process.stderr.write(`hub-fetch: ${message}\n`);
	process.exit(1);
}

const hubId = process.argv[2];
if (hubId === undefined || !/^[\w.-]+\/[\w.-]+$/.test(hubId)) {
	fail(`expected a hub dataset id (owner/name), got: ${String(hubId)}`);
}
if (hubId !== PINNED_DATASET_ID) {
	fail(`only the design-pinned dataset '${PINNED_DATASET_ID}' is supported, got: ${hubId}`);
}

async function getJson(url: string): Promise<Record<string, any>> {
	const response = await fetch(url, {
		headers: {
			// Anonymous reads of public datasets; HF_TOKEN flows through the
			// environment for authenticated clones when present.
			...(process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {}),
		},
	});
	if (!response.ok) {
		fail(`GET ${url} failed: ${String(response.status)} ${await response.text()}`.slice(0, 400));
	}
	return (await response.json()) as Record<string, any>;
}

/** First config that actually serves the requested split. */
async function resolveConfig(revision: string): Promise<string> {
	const configs = await getJson(
		`${HUB_SERVER_BASE}/splits?dataset=${encodeURIComponent(hubId)}&revision=${revision}`,
	);
	const candidates: string[] = Array.isArray(configs.splits)
		? configs.splits.filter((entry: any) => entry?.split === SPLIT).map((entry: any) => String(entry.config))
		: [];
	if (candidates.length === 0) fail(`no config serves split '${SPLIT}' for ${hubId}`);
	return candidates[0];
}

async function fetchRows(revision: string, config: string): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	let offset = 0;
	let total = Number.POSITIVE_INFINITY;
	while (offset < total) {
		// Every page — the first AND each paginated follow-up — is pinned to the
		// exact design-pinned 40-hex sha. Without `revision` here, datasets-server
		// serves the page from whatever the default-branch head is at that
		// moment, letting a head that moved mid-pagination silently swap rows.
		const page = await getJson(
			`${HUB_SERVER_BASE}/rows?dataset=${encodeURIComponent(hubId)}` +
				`&config=${encodeURIComponent(config)}&split=${SPLIT}` +
				`&offset=${offset}&length=${PAGE_SIZE}&revision=${revision}`,
		);
		total = Number(page.num_rows_total ?? Number.POSITIVE_INFINITY);
		const batch = Array.isArray(page.rows) ? page.rows : [];
		if (batch.length === 0) break;
		for (const entry of batch) {
			const row = entry?.row;
			if (row !== null && typeof row === "object") rows.push(row as Record<string, unknown>);
		}
		offset += batch.length;
	}
	if (rows.length === 0) fail(`dataset ${hubId} split '${SPLIT}' returned no rows`);
	return rows;
}

const revision = PINNED_DATASET_REVISION;
const config = await resolveConfig(revision);
const instances = await fetchRows(revision, config);

process.stdout.write(
	`${JSON.stringify({
		schema_version: 1,
		dataset_id: hubId,
		split: SPLIT,
		revision,
		harness_commit: PINNED_HARNESS_COMMIT,
		instances,
	})}\n`,
);
