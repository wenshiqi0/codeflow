/**
 * Dataset loading and the leakage boundary (design §2, §3, §13.3).
 *
 * The model-visible instance must be an EXPLICIT ALLOWLIST projection, not a
 * full record with known evaluator-only fields deleted. The difference is
 * future-proof: a new dataset field would flow straight through a
 * delete-based projection and leak the next evaluator-only addition. Here the
 * projection is asserted on construction semantics — exact key set — so any
 * unknown field cannot leak either.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTmpDirs, loadBenchmarkModule, makeTmpDir, SNAPSHOT } from "./helpers";

afterEach(cleanupTmpDirs);

async function bench(): Promise<any> {
	return loadBenchmarkModule();
}

describe("dataset snapshot loading", () => {
	test("loads the fixture snapshot with its pinned identity", async () => {
		const mod = await bench();
		const dataset = mod.loadBenchmarkDataset(SNAPSHOT);
		expect(dataset.dataset_id).toBe("SWE-bench/SWE-bench_Verified");
		expect(dataset.split).toBe("test");
		expect(dataset.revision).toMatch(/^[0-9a-f]{40}$/);
		expect(dataset.harness_commit).toMatch(/^[0-9a-f]{40}$/);
		expect(dataset.instances).toHaveLength(5);
		const first = dataset.instances[0];
		// The fixture carries the full real field set, evaluator-only fields included.
		for (const field of [
			"instance_id",
			"repo",
			"base_commit",
			"problem_statement",
			"patch",
			"test_patch",
			"FAIL_TO_PASS",
			"PASS_TO_PASS",
		]) {
			expect(first[field]).toBeDefined();
		}
	});

	test("rejects a moving revision alias — the manifest must record an exact revision", async () => {
		const mod = await bench();
		const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
		snapshot.revision = "main";
		const file = path.join(makeTmpDir(), "snapshot-alias.json");
		fs.writeFileSync(file, JSON.stringify(snapshot));
		expect(() => mod.loadBenchmarkDataset(file)).toThrow(mod.BenchmarkDatasetError);
		expect(() => mod.loadBenchmarkDataset(file)).toThrow(/revision/i);
	});

	test("rejects a missing or non-sha harness commit", async () => {
		const mod = await bench();
		const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
		snapshot.harness_commit = "latest";
		const file = path.join(makeTmpDir(), "snapshot-harness.json");
		fs.writeFileSync(file, JSON.stringify(snapshot));
		expect(() => mod.loadBenchmarkDataset(file)).toThrow(mod.BenchmarkDatasetError);
	});

	test("rejects duplicate instance ids", async () => {
		const mod = await bench();
		const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
		snapshot.instances = [snapshot.instances[0], snapshot.instances[0]];
		const file = path.join(makeTmpDir(), "snapshot-dup.json");
		fs.writeFileSync(file, JSON.stringify(snapshot));
		expect(() => mod.loadBenchmarkDataset(file)).toThrow(mod.BenchmarkDatasetError);
	});

	test("allowlist filters in dataset order and refuses unknown ids", async () => {
		const mod = await bench();
		const dataset = mod.loadBenchmarkDataset(SNAPSHOT);
		// Deliberately unordered: selection must preserve DATASET order, not input order.
		const selected = mod.selectInstances(dataset, ["demo/demo-1002", "demo/demo-1001"]);
		expect(selected.map((i: any) => i.instance_id)).toEqual(["demo/demo-1001", "demo/demo-1002"]);
		expect(() => mod.selectInstances(dataset, ["demo/nope-9999"])).toThrow(
			mod.BenchmarkDatasetError,
		);
	});
});

describe("model-visible instance is an explicit allowlist projection", () => {
	test("the allowlist constant is exactly the four visible fields", async () => {
		const mod = await bench();
		expect([...mod.MODEL_VISIBLE_INSTANCE_FIELDS].sort()).toEqual([
			"base_commit",
			"instance_id",
			"problem_statement",
			"repo",
		]);
	});

	test("projection output has exactly the allowlist keys — no more, no fewer", async () => {
		const mod = await bench();
		const dataset = mod.loadBenchmarkDataset(SNAPSHOT);
		for (const instance of dataset.instances) {
			const visible = mod.projectModelVisibleInstance(instance);
			expect(Object.keys(visible).sort()).toEqual([
				"base_commit",
				"instance_id",
				"problem_statement",
				"repo",
			]);
			expect(visible.instance_id).toBe(instance.instance_id);
			expect(visible.repo).toBe(instance.repo);
			expect(visible.base_commit).toBe(instance.base_commit);
			expect(visible.problem_statement).toBe(instance.problem_statement);
		}
	});

	test("a brand-new dataset field cannot leak: projection stays at four keys", async () => {
		// Construction semantics, not deletion: whatever the dataset grows next
		// (here simulated by unknown fields) must never reach the model.
		const mod = await bench();
		const dataset = mod.loadBenchmarkDataset(SNAPSHOT);
		const extended = {
			...dataset.instances[0],
			expected_test_results: { "test-x": "PASSED_CANARY" },
			grader_secret: "CANARY_GRADER",
			newly_added_v2_field: { anything: ["goes", "here"] },
		};
		const visible = mod.projectModelVisibleInstance(extended);
		expect(Object.keys(visible).sort()).toEqual([
			"base_commit",
			"instance_id",
			"problem_statement",
			"repo",
		]);
		const serialized = JSON.stringify(visible);
		expect(serialized).not.toContain("CANARY");
		expect(serialized).not.toContain("expected_test_results");
	});

	test("the committed fixture snapshot really carries canaries in evaluator-only fields", () => {
		// Sanity for the leakage scan elsewhere: if this ever stops holding, the
		// canary assertions would silently stop testing anything.
		const raw = fs.readFileSync(SNAPSHOT, "utf8");
		for (const marker of [
			"CANARY_GOLD_PATCH_1001",
			"CANARY_TEST_PATCH_1001",
			"CANARY_F2P_1001",
			"CANARY_P2P_1001",
			"CANARY_HINTS_1001",
			"CANARY_FUTURE_FIELD_1001",
		]) {
			expect(raw).toContain(marker);
		}
	});
});
