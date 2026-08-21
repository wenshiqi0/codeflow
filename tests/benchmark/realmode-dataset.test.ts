/**
 * Hub dataset acceptance in real mode (design §2, §10): `--dataset` accepts
 * the official hub id — resolved offline through the fake fetch seam — and the
 * manifest must record the EXACT resolved revision, never the movable alias.
 *
 * RED against the current milestone on purpose: `loadBenchmarkDataset`
 * currently rejects every hub id ("needs real mode with dataset download
 * access") and no resolution path exists, so no exact resolved revision is
 * ever recorded.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTmpDirs, makeTmpDir, readJson, readJsonl, runCodeflow } from "./helpers";
import {
	buildRealmodeWorld,
	INSTANCE_HUB,
	PINNED_HARNESS_COMMIT,
	RESOLVED_HUB_REVISION,
	type RealmodeWorld,
} from "./realmode-world";

let world: RealmodeWorld;

beforeAll(() => {
	world = buildRealmodeWorld();
}, 60_000);

afterAll(cleanupTmpDirs);

const HUB_ID = "SWE-bench/SWE-bench_Verified";

describe("REAL-14: the official dataset id is accepted and resolved to an exact revision", () => {
	test("run completes; manifest records the resolved revision and source hub", () => {
		const outDir = makeTmpDir("codeflow-bench-hub-");
		const capture = world.newCapture();
		const result = runCodeflow(
			["benchmark", "run", "--dataset", HUB_ID, "--out", outDir],
			world.env(capture),
			90_000,
		);
		expect(result.stderr).not.toContain("needs real mode");
		expect(result.exitCode).toBe(0);

		const manifest = readJson(path.join(outDir, "benchmark-run.json"));
		expect(manifest.dataset.dataset_id).toBe(HUB_ID);
		expect(manifest.dataset.split).toBe("test");
		expect(manifest.dataset.revision).toBe(RESOLVED_HUB_REVISION); // what resolution returned
		expect(manifest.dataset.revision).toMatch(/^[0-9a-f]{40}$/); // never the alias
		expect(manifest.dataset.revision).not.toBe("main");
		expect(manifest.dataset.source).toBe("hub");
		expect(manifest.harness.commit).toBe(PINNED_HARNESS_COMMIT);
		expect(manifest.codeflow_commit).toMatch(/^[0-9a-f]{40}$/);

		// The resolver was actually asked for the hub id...
		const fetchLog = path.join(capture, "fetch-calls.jsonl");
		expect(fs.existsSync(fetchLog)).toBe(true);
		const calls = readJsonl(fetchLog);
		expect(calls.some((c: any) => c.argv.includes(HUB_ID) || c.hub_id === HUB_ID)).toBe(true);

		// ...and the resolved instance really ran and was graded resolved.
		const caseFile = readJson(path.join(outDir, "cases", INSTANCE_HUB.replace(/\//g, "__"), "case.json"));
		expect(caseFile.attempts[0].verdict).toBe("resolved");
		expect(readJson(path.join(outDir, "report.json")).comparison_keys.dataset_revision).toBe(
			RESOLVED_HUB_REVISION,
		);
	});
});

describe("REAL-15: a movable alias can never be recorded as the resolved revision", () => {
	test("resolution returning `main` fails loudly and fabricates no results", () => {
		const outDir = makeTmpDir("codeflow-bench-alias-");
		const capture = world.newCapture();
		const result = runCodeflow(
			["benchmark", "run", "--dataset", HUB_ID, "--out", outDir],
			world.env(capture, { fetchMode: "alias" }),
			90_000,
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/revision|40-hex|alias/i);
		// Nothing may be recorded as if a benchmark had run.
		expect(fs.existsSync(path.join(outDir, "report.json"))).toBe(false);
		expect(fs.existsSync(path.join(outDir, "predictions.jsonl"))).toBe(false);
	});
});
