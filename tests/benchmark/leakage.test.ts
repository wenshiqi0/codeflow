/**
 * Leakage through the runner (design §3, §13.3).
 *
 * The dataset projection test pins construction semantics; this file pins the
 * runtime surface: what the Codeflow driver is handed, what lands in the
 * workspace, what the evaluator sees, and what the attempt ledgers record.
 * Evaluator-only data must never appear in any of them.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	CANARY_PREFIX,
	cleanupTmpDirs,
	listFiles,
	loadBenchmarkModule,
	makeTmpDir,
	SNAPSHOT,
} from "./helpers";

afterEach(cleanupTmpDirs);

async function bench(): Promise<any> {
	return loadBenchmarkModule();

}

/**
 * A driver that plays one scripted round per instance and writes one file,
 * recording everything it was handed. If the runner ever passes more than the
 * allowlist projection, `inputs` makes it visible.
 */
function spyingDriver(inputs: any[], workspaces: string[] = []) {
	return {
		startAttempt(input: any) {
			inputs.push(JSON.parse(JSON.stringify(input)));
			return (async function* () {
				yield {
					type: "workspace_write",
					path: "fix.py",
					content: `def fix():\n    return "FIXED_${input.instance.instance_id.split("-").pop()}"\n`,
				};
				yield {
					type: "round",
					round: {
						role: "coder",
						provider: "fixture",
						model: "fixture-coder",
						usage: {
							input: 100,
							output: 20,
							reasoning: 0,
							cache_read: 0,
							cache_write: 0,
							total_tokens: 120,
							cost: null,
						},
						tool_calls: [
							{ call_id: "x1", tool: "bash", status: "succeeded" },
							{ call_id: "x2", tool: "bash", status: "succeeded" },
							{ call_id: "x3", tool: "read", status: "failed" },
						],
					},
				};
				workspaces.push(input.workspaceDir);
			})();
		},
	};
}

describe("the driver sees only the allowlist projection", () => {
	test("every attempt input carries exactly the four visible instance fields", async () => {
		const mod = await bench();
		const inputs: any[] = [];
		const outDir = makeTmpDir();
		await mod.runBenchmark({
			dataset: SNAPSHOT,
			outDir,
			driver: spyingDriver(inputs),
			evaluator: { async evaluate() { return "resolved"; } },
			clock: { now: () => 0 },
			codeflowCommit: "0".repeat(40),
		});
		expect(inputs.length).toBe(5);
		for (const input of inputs) {
			expect(Object.keys(input.instance).sort()).toEqual([
				"base_commit",
				"instance_id",
				"problem_statement",
				"repo",
			]);
		}
	});

	test("the serialized attempt input contains no evaluator-only data at all", async () => {
		const mod = await bench();
		const inputs: any[] = [];
		const outDir = makeTmpDir();
		await mod.runBenchmark({
			dataset: SNAPSHOT,
			outDir,
			driver: spyingDriver(inputs),
			evaluator: { async evaluate() { return "resolved"; } },
			clock: { now: () => 0 },
			codeflowCommit: "0".repeat(40),
		});
		for (const input of inputs) {
			const serialized = JSON.stringify(input);
			expect(serialized).not.toContain(CANARY_PREFIX);
			expect(serialized).not.toContain("test_patch");
			expect(serialized).not.toContain("FAIL_TO_PASS");
			expect(serialized).not.toContain("PASS_TO_PASS");
			expect(serialized).not.toContain("patch");
		}
	});

	test("the input shape is exactly the contract's driver input — no dataset passthrough", async () => {
		const mod = await bench();
		const inputs: any[] = [];
		const outDir = makeTmpDir();
		await mod.runBenchmark({
			dataset: SNAPSHOT,
			instances: ["demo/demo-1001"],
			outDir,
			driver: spyingDriver(inputs),
			evaluator: { async evaluate() { return "resolved"; } },
			clock: { now: () => 0 },
			codeflowCommit: "0".repeat(40),
		});
		expect(Object.keys(inputs[0]).sort()).toEqual([
			"attempt",
			"budgets",
			"clock",
			"instance",
			"modelConfig",
			"wallDeadlineMs",
			"workspaceDir",
		]);
	});
});

describe("workspace and artifacts stay clean", () => {
	test("the workspace holds driver writes and git only — no hint or test files", async () => {
		const mod = await bench();
		const inputs: any[] = [];
		const workspaces: string[] = [];
		const outDir = makeTmpDir();
		await mod.runBenchmark({
			dataset: SNAPSHOT,
			instances: ["demo/demo-1001"],
			outDir,
			driver: spyingDriver(inputs, workspaces),
			evaluator: { async evaluate() { return "resolved"; } },
			clock: { now: () => 0 },
			codeflowCommit: "0".repeat(40),
		});
		const entries = fs.readdirSync(workspaces[0]).sort();
		expect(entries).toEqual([".git", "fix.py"]);
		const file = fs.readFileSync(path.join(workspaces[0], "fix.py"), "utf8");
		expect(file).toContain("FIXED_1001");
		expect(file).not.toContain(CANARY_PREFIX);
	});

	test("no canary reaches any file under the benchmark out dir", async () => {
		const mod = await bench();
		const outDir = makeTmpDir();
		await mod.runBenchmark({
			dataset: SNAPSHOT,
			outDir,
			driver: spyingDriver([]),
			evaluator: { async evaluate() { return "resolved"; } },
			clock: { now: () => 0 },
			codeflowCommit: "0".repeat(40),
		});
		const files = listFiles(outDir);
		expect(files.length).toBeGreaterThan(0); // never vacuous
		for (const rel of files) {
			const content = fs.readFileSync(path.join(outDir, rel), "utf8");
			expect(`${rel}: ${content}`).not.toContain(CANARY_PREFIX);
		}
	});

	test("the evaluator receives the extracted workspace patch, never the gold patch", async () => {
		const mod = await bench();
		const evalCalls: any[] = [];
		const outDir = makeTmpDir();
		await mod.runBenchmark({
			dataset: SNAPSHOT,
			instances: ["demo/demo-1001"],
			outDir,
			driver: spyingDriver([]),
			evaluator: {
				async evaluate(request: any) {
					evalCalls.push(request);
					return "resolved";
				},
			},
			clock: { now: () => 0 },
			codeflowCommit: "0".repeat(40),
		});
		expect(evalCalls).toHaveLength(1);
		expect(evalCalls[0].prediction.model_patch).toContain("FIXED_1001");
		expect(JSON.stringify(evalCalls[0])).not.toContain(CANARY_PREFIX);
		expect(evalCalls[0].instanceId).toBe("demo/demo-1001");
		expect(evalCalls[0].evaluationRunId).toContain("demo__demo-1001");
	});

	test("model-visible ledgers carry numbers and attribution only", async () => {
		const mod = await bench();
		const outDir = makeTmpDir();
		await mod.runBenchmark({
			dataset: SNAPSHOT,
			instances: ["demo/demo-1001"],
			outDir,
			driver: spyingDriver([]),
			evaluator: { async evaluate() { return "resolved"; } },
			clock: { now: () => 0 },
			codeflowCommit: "0".repeat(40),
		});
		const attemptDir = path.join(outDir, "cases", "demo__demo-1001", "attempts", "1");
		const usageRaw = fs.readFileSync(path.join(attemptDir, "usage.jsonl"), "utf8");
		const toolRaw = fs.readFileSync(path.join(attemptDir, "tool-calls.jsonl"), "utf8");
		expect(`${usageRaw}${toolRaw}`).not.toContain(CANARY_PREFIX);
		expect(`${usageRaw}${toolRaw}`).not.toContain("problem_statement");
		for (const line of toolRaw.split("\n").filter((l) => l.trim())) {
			expect(Object.keys(JSON.parse(line)).sort()).toEqual([
				"at",
				"call_id",
				"depth",
				"goal_id",
				"handoff_id",
				"kind",
				"lane",
				"model",
				"provider",
				"role",
				"run_id",
				"schema_version",
				"status",
				"tool",
			]);
		}
	});
});
