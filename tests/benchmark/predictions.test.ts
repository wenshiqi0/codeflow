/**
 * predictions.jsonl — the official field contract (design §10, §13.8).
 *
 * The official harness consumes this file directly, so the shape is not ours
 * to bend: exactly instance_id / model_name_or_path / model_patch, complete
 * lines only. Appends must be whole lines so an interrupted run can never
 * leave half a JSON object behind.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTmpDirs, loadBenchmarkModule, makeTmpDir, readJsonl } from "./helpers";

afterEach(cleanupTmpDirs);

async function bench(): Promise<any> {
	return loadBenchmarkModule();
}

const OFFICIAL_KEYS = ["instance_id", "model_name_or_path", "model_patch"];

describe("official field contract", () => {
	test("appended predictions carry exactly the three official keys", async () => {
		const mod = await bench();
		const outDir = makeTmpDir();
		mod.appendPredictionEntry(outDir, {
			instance_id: "demo/demo-1001",
			model_name_or_path: "fixture/fake-model",
			model_patch: "diff --git a/fix.py b/fix.py\n",
		});
		mod.appendPredictionEntry(outDir, {
			instance_id: "demo/demo-1002",
			model_name_or_path: "fixture/fake-model",
			model_patch: "",
		});
		const lines = readJsonl(path.join(outDir, "predictions.jsonl"));
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(Object.keys(line).sort()).toEqual([...OFFICIAL_KEYS].sort());
			expect(typeof line.instance_id).toBe("string");
			expect(typeof line.model_name_or_path).toBe("string");
			expect(typeof line.model_patch).toBe("string");
		}
		// An empty patch is representable: "no change" is a legal prediction.
		expect(lines[1].model_patch).toBe("");
	});

	test("append refuses extra keys — the official contract is not extensible here", async () => {
		const mod = await bench();
		const outDir = makeTmpDir();
		expect(() =>
			mod.appendPredictionEntry(outDir, {
				instance_id: "demo/demo-1001",
				model_name_or_path: "m",
				model_patch: "p",
				test_patch: "CANARY_TEST_PATCH_1001",
			}),
		).toThrow();
		expect(() =>
			mod.appendPredictionEntry(outDir, {
				instance_id: "demo/demo-1001",
				model_name_or_path: "m",
				// missing model_patch
			}),
		).toThrow();
		expect(fs.existsSync(path.join(outDir, "predictions.jsonl"))).toBe(false);
	});

	test("readPredictions round-trips and rejects malformed lines loudly", async () => {
		const mod = await bench();
		const outDir = makeTmpDir();
		const file = path.join(outDir, "predictions.jsonl");
		mod.appendPredictionEntry(outDir, {
			instance_id: "demo/demo-1001",
			model_name_or_path: "m",
			model_patch: "p",
		});
		expect(mod.readPredictions(file)).toHaveLength(1);
		// A truncated half line must not be silently skipped — that is how a
		// corrupt artifact would masquerade as a complete run.
		fs.appendFileSync(file, '{"instance_id": "demo/demo-1002", "model_name');
		expect(() => mod.readPredictions(file)).toThrow();
	});
});

describe("workspace patch extraction (offline git)", () => {
	test("prepare + write + extract yields a diff of exactly the new content", async () => {
		const mod = await bench();
		const dir = path.join(makeTmpDir(), "workspace");
		mod.prepareBenchmarkWorkspace(dir);
		expect(mod.extractPatch(dir)).toBe("");
		fs.mkdirSync(path.dirname(path.join(dir, "fix.py")), { recursive: true });
		fs.writeFileSync(path.join(dir, "fix.py"), "def fix():\n    return 'FIXED'\n", "utf8");
		const patch = mod.extractPatch(dir);
		expect(patch).toContain("fix.py");
		expect(patch).toContain("FIXED");
		expect(patch).toMatch(/^diff --git/m);
		// Extraction is idempotent: reading twice does not grow the patch.
		expect(mod.extractPatch(dir)).toBe(patch);
	});
});
