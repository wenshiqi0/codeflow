/**
 * SWE-bench Verified dataset loading and the model-visible allowlist
 * projection (design §2, §3).
 *
 * The projection is CONSTRUCTION-based: a fresh object built from exactly the
 * four allowlisted fields. Delete-based projection would leak every future
 * evaluator-only field the dataset grows, so `projectModelVisibleInstance`
 * never sees more than the allowlist keys on its output in the first place.
 *
 * Gold `patch`, `test_patch`, `FAIL_TO_PASS`, `PASS_TO_PASS`, `hints_text`,
 * and any unknown future field are evaluator-only and never model-visible.
 */

import * as fs from "node:fs";
import { fetchHubDatasetDocument } from "./process";

export const BENCHMARK_DATASET_SCHEMA_VERSION = 1;

/**
 * A full SWE-bench Verified record, evaluator-only fields included.
 *
 * `[key: string]: unknown` is deliberate: future dataset fields flow into the
 * loaded record but cannot pass the allowlist projection below.
 */
export interface BenchmarkInstance {
	instance_id: string;
	repo: string;
	base_commit: string;
	problem_statement: string;
	/** Gold patch — evaluator-only. */
	patch: string;
	/** Evaluator-only. */
	test_patch: string;
	/** Evaluator-only. */
	FAIL_TO_PASS: string[];
	/** Evaluator-only. */
	PASS_TO_PASS: string[];
	environment_setup_commit?: string;
	/** Evaluator-only. */
	hints_text?: string;
	created_at?: string;
	version?: string;
	[key: string]: unknown;
}

/** The model-visible instance: an explicit allowlist projection. */
export interface ModelVisibleInstance {
	instance_id: string;
	repo: string;
	base_commit: string;
	problem_statement: string;
}

/** Exactly the four keys a Codeflow run may ever see for an instance. */
export const MODEL_VISIBLE_INSTANCE_FIELDS: readonly string[] = [
	"instance_id",
	"repo",
	"base_commit",
	"problem_statement",
];

/**
 * Construct a fresh object from the allowlist — never copy-and-delete.
 * Unknown future fields on `instance` cannot reach the output by construction.
 */
export function projectModelVisibleInstance(instance: BenchmarkInstance): ModelVisibleInstance {
	return {
		instance_id: instance.instance_id,
		repo: instance.repo,
		base_commit: instance.base_commit,
		problem_statement: instance.problem_statement,
	};
}

export class BenchmarkDatasetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BenchmarkDatasetError";
	}
}

export interface BenchmarkDataset {
	dataset_id: string;
	split: string;
	/** Exact 40-hex sha, never a moving alias such as `main`. */
	revision: string;
	/** Exact 40-hex sha of the official harness pinned with the dataset. */
	harness_commit: string;
	instances: BenchmarkInstance[];
	/** Snapshot path or hub id, exactly as passed in. */
	source: string;
}

/** How the dataset reached the runner; recorded in the benchmark manifest. */
export function datasetSourceKind(source: string): "local-snapshot" | "hub" {
	return fs.existsSync(source) ? "local-snapshot" : "hub";
}

const SHA_40 = /^[0-9a-f]{40}$/;
const HUB_ID = /^[\w.-]+\/[\w.-]+$/;

function nonEmptyString(value: unknown, what: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new BenchmarkDatasetError(`${what} must be a non-empty string`);
	}
	return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRevision(value: unknown, what: string): string {
	const revision = nonEmptyString(value, what);
	if (!SHA_40.test(revision)) {
		throw new BenchmarkDatasetError(
			`${what} must be an exact 40-hex commit sha (moving aliases such as main or latest are rejected; the manifest must pin what actually ran): ${revision}`,
		);
	}
	return revision;
}

function validateVisibleFields(instance: Record<string, unknown>, index: number): void {
	for (const field of MODEL_VISIBLE_INSTANCE_FIELDS) {
		const value = instance[field];
		if (typeof value !== "string" || value.length === 0) {
			throw new BenchmarkDatasetError(
				`instance ${index} is missing visible field '${field}' or has an empty value`,
			);
		}
	}
}

/**
 * Load a dataset from a pinned local snapshot file (the only offline form) or
 * resolve a hub dataset id (`owner/name`) through the dataset fetch seam
 * (real mode; tests point CODEFLOW_BENCHMARK_DATASET_FETCH_BIN at a fake).
 *
 * A hub id resolves to exactly one snapshot document on the fetch command's
 * stdout, which is validated exactly like a local snapshot — a movable alias
 * (main, latest) is rejected loudly and never recorded as the revision.
 *
 * Validation failures throw {@link BenchmarkDatasetError}: wrong schema
 * version, non-40-hex revision or harness commit, empty instances, an
 * instance missing a visible field, duplicate instance ids.
 */
export function loadBenchmarkDataset(source: string): BenchmarkDataset {
	if (typeof source !== "string" || source.trim() === "") {
		throw new BenchmarkDatasetError(
			"dataset source is required: a pinned local snapshot file or a hub dataset id",
		);
	}
	if (!fs.existsSync(source)) {
		if (!HUB_ID.test(source)) {
			throw new BenchmarkDatasetError(`dataset snapshot not found: ${source}`);
		}
		// Real mode: resolve the official hub id to a pinned snapshot document.
		let document: string;
		try {
			document = fetchHubDatasetDocument(source);
		} catch (error) {
			throw new BenchmarkDatasetError((error as Error).message);
		}
		let hubParsed: unknown;
		try {
			hubParsed = JSON.parse(document);
		} catch (error) {
			throw new BenchmarkDatasetError(
				`hub dataset '${source}' resolved to a document that is not valid JSON: ${(error as Error).message}`,
			);
		}
		return parseSnapshotDocument(source, hubParsed);
	}
	if (!fs.statSync(source).isFile()) {
		throw new BenchmarkDatasetError(`dataset source is not a snapshot file: ${source}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(source, "utf8"));
	} catch (error) {
		throw new BenchmarkDatasetError(
			`dataset snapshot is not valid JSON: ${source} (${(error as Error).message})`,
		);
	}
	return parseSnapshotDocument(source, parsed);
}

function parseSnapshotDocument(source: string, parsed: unknown): BenchmarkDataset {
	if (!isObject(parsed)) {
		throw new BenchmarkDatasetError(`dataset snapshot must be a JSON object: ${source}`);
	}
	if (parsed.schema_version !== BENCHMARK_DATASET_SCHEMA_VERSION) {
		throw new BenchmarkDatasetError(
			`dataset snapshot schema_version must be ${BENCHMARK_DATASET_SCHEMA_VERSION}: ${source}`,
		);
	}

	const datasetId = nonEmptyString(parsed.dataset_id, "dataset_id");
	const split = nonEmptyString(parsed.split, "split");
	const revision = validateRevision(parsed.revision, "dataset revision");
	const harnessCommit = validateRevision(parsed.harness_commit, "harness commit");

	const rawInstances = parsed.instances;
	if (!Array.isArray(rawInstances) || rawInstances.length === 0) {
		throw new BenchmarkDatasetError(`dataset snapshot must carry a non-empty instances array: ${source}`);
	}

	const seen = new Set<string>();
	const instances: BenchmarkInstance[] = rawInstances.map((raw, index) => {
		if (!isObject(raw)) {
			throw new BenchmarkDatasetError(`dataset instance ${index} is not an object: ${source}`);
		}
		validateVisibleFields(raw, index);
		const id = raw.instance_id as string;
		if (seen.has(id)) {
			throw new BenchmarkDatasetError(`duplicate instance_id in dataset: ${id}`);
		}
		seen.add(id);
		return raw as BenchmarkInstance;
	});

	return {
		dataset_id: datasetId,
		split,
		revision,
		harness_commit: harnessCommit,
		instances,
		source,
	};
}

/**
 * Filter by `instance_id` preserving DATASET order (not allowlist order).
 * An allowlist id absent from the dataset throws; null/undefined selects all.
 */
export function selectInstances(
	dataset: BenchmarkDataset,
	allowlist?: string[] | null,
): BenchmarkInstance[] {
	if (allowlist === null || allowlist === undefined) return [...dataset.instances];
	const known = new Set(dataset.instances.map((instance) => instance.instance_id));
	for (const id of allowlist) {
		if (!known.has(id)) {
			throw new BenchmarkDatasetError(`allowlist instance not present in dataset: ${id}`);
		}
	}
	const wanted = new Set(allowlist);
	return dataset.instances.filter((instance) => wanted.has(instance.instance_id));
}
