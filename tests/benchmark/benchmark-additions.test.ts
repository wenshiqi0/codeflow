/**
 * Design B additions: source-clock timing, TTFP, usage/handoff attribution,
 * and non-official multi-attempt dispersion. All paths are offline.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTmpDirs, loadBenchmarkModule, makeTmpDir } from "./helpers";
import type { DriverEvent, DriverRound } from "../../../runtime/lib/benchmark/driver";

afterEach(cleanupTmpDirs);

const BASE_MS = Date.parse("2026-08-21T00:00:00Z");

function usage(input: number, cacheRead: number | null = 0) {
	return {
		input,
		output: 10,
		reasoning: 0,
		cache_read: cacheRead,
		cache_write: 0,
		total_tokens: input + 10 + (cacheRead ?? 0),
		cost: null,
	};
}

function round(overrides: Partial<DriverRound> = {}): DriverRound {
	return {
		role: "coder",
		provider: "fixture",
		model: "fixture-model",
		usage: usage(100),
		...overrides,
	};
}

function writeRuntimeHandoff(
	workspaceDir: string,
	handoffId: string,
	state: Record<string, unknown>,
): void {
	const file = path.resolve(
		workspaceDir,
		"..",
		"codeflow-runs",
		"run-inner",
		"handoffs",
		handoffId,
		"state.json",
	);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		JSON.stringify({
			schema_version: 2,
			run_id: "run-inner",
			handoff_id: handoffId,
			depth: 1,
			...state,
		}),
	);
}

async function runCustomBenchmark(driver: {
	startAttempt(input: any): AsyncGenerator<DriverEvent, void, unknown>;
}, evaluate: (request: any) => Promise<string>, options: { attempts?: number; onClock?: (setNow: (value: number) => void) => void } = {}) {
	const mod = await loadBenchmarkModule();
	let nowMs = BASE_MS;
	const outDir = path.join(makeTmpDir(), "out");
	options.onClock?.((value: number) => (nowMs = value));
	const result = await mod.runBenchmark({
		dataset: "tests/benchmark/fixtures/verified-snapshot.json",
		instances: ["demo/demo-1001"],
		outDir,
		benchmarkRunId: "bench-20260821-000000-add",
		modelNameOrPath: "fixture/model",
		driverMode: "fixture",
		codeflowCommit: "0123456789abcdef0123456789abcdef01234567",
		attempts: options.attempts,
		clock: { now: () => nowMs },
		driver,
		evaluator: { evaluate },
	});
	const caseFile = JSON.parse(
		fs.readFileSync(path.join(outDir, "cases", "demo__demo-1001", "case.json"), "utf8"),
	);
	return { mod, outDir, result, caseFile, setNow: (value: number) => (nowMs = value) };
}

describe("B1 source-clock timing and TTFP", () => {
	test("canonical tool rows preserve source timestamps and overlap is unioned", async () => {
		let setNow: ((value: number) => void) | undefined;
		const driver = {
			async *startAttempt(input: any) {
				writeRuntimeHandoff(input.workspaceDir, "h00001-coder", {
					role: "coder",
					status: "done",
					result: "PASS",
					goal_id: "goal-1",
					lane: "code",
				});
				yield { type: "workspace_write", path: "new-file.py", content: "print('fix')\n" };
				setNow?.(BASE_MS + 1000);
				yield {
					type: "tool_calls",
					role: "coder",
					provider: "fixture",
					model: "fixture-model",
					goal_id: "goal-1",
					lane: "code",
					handoff_id: "h00001-coder",
					calls: [
						{
							call_id: "a",
							tool: "bash",
							status: "succeeded",
							requested_at: new Date(BASE_MS + 1000).toISOString(),
							result_at: new Date(BASE_MS + 3000).toISOString(),
						},
						{
							call_id: "b",
							tool: "read",
							status: "succeeded",
							requested_at: new Date(BASE_MS + 2000).toISOString(),
							result_at: new Date(BASE_MS + 4000).toISOString(),
						},
					],
				};
				setNow?.(BASE_MS + 4000);
				yield {
					type: "round",
					round: round({
						depth: 1,
						turn: 1,
						handoff_id: "h00001-coder",
						goal_id: "goal-1",
						lane: "code",
					}),
				};
			},
		};
		const { outDir, caseFile } = await runCustomBenchmark(driver, async () => "resolved", {
			onClock: (setter) => (setNow = setter),
		});
		const rows = fs
			.readFileSync(path.join(outDir, "cases", "demo__demo-1001", "attempts", "1", "tool-calls.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map(JSON.parse);
		expect(rows.find((row) => row.call_id === "a" && row.kind === "requested").at).toBe(
			new Date(BASE_MS + 1000).toISOString(),
		);
		expect(rows.find((row) => row.call_id === "a" && row.kind === "result").at).toBe(
			new Date(BASE_MS + 3000).toISOString(),
		);
		expect(caseFile.attempts[0].metrics.wall_breakdown.tool_execution_seconds).toBe(3);
		expect(caseFile.attempts[0].metrics.time_to_first_patch_seconds).toBe(0);
	});
});

describe("B4 waste and context growth", () => {
	test("usage depth/turn joins handoff terminal state without prose", async () => {
		const driver = {
			async *startAttempt(input: any) {
				writeRuntimeHandoff(input.workspaceDir, "h00001-coder", {
					role: "coder",
					status: "done",
					result: "FAIL",
					goal_id: "goal-1",
					lane: "code",
					summary: "secret failure prose",
				});
				writeRuntimeHandoff(input.workspaceDir, "h00002-coder", {
					role: "coder",
					status: "done",
					result: "PASS",
					goal_id: "goal-1",
					lane: "code",
				});
				writeRuntimeHandoff(input.workspaceDir, "h00003-coder", {
					role: "coder",
					status: "done",
					result: "PASS",
					goal_id: "goal-1",
					lane: "code",
				});
				yield { type: "round", round: round({ role: "planner", depth: 0, turn: 1, usage: usage(100) }) };
				yield {
					type: "round",
					round: round({
						depth: 1,
						turn: 1,
						handoff_id: "h00001-coder",
						goal_id: "goal-1",
						lane: "code",
						usage: usage(200, 100),
					}),
				};
				yield {
					type: "round",
					round: round({
						depth: 1,
						turn: 2,
						handoff_id: "h00001-coder",
						goal_id: "goal-1",
						lane: "code",
						usage: usage(300, 150),
					}),
				};
				yield {
					type: "round",
					round: round({
						depth: 1,
						turn: 1,
						handoff_id: "h00002-coder",
						goal_id: "goal-1",
						lane: "code",
						usage: usage(400, 200),
					}),
				};
			},
		};
		const { result } = await runCustomBenchmark(driver, async () => "resolved");
		expect(result.report.runtime_observability.waste).toMatchObject({
			rounds_in_non_pass_handoffs: 2,
			tokens_in_non_pass_handoffs: 770,
			waste_ratio_rounds: 0.5,
			planner_rounds_ratio: 0.25,
			handoff_reopens_per_goal_lane_median: 2,
			metrics_available: true,
		});
		expect(result.report.runtime_observability.context_growth).toEqual({
			first_turn_input_by_handoff_index: [300, 600],
			metrics_available: true,
		});
	});
});

describe("B2 multiple attempts", () => {
	test("independent attempts compute pass@1/pass@N and mark the report non-official", async () => {
		const driver = {
			async *startAttempt(input: any) {
				fs.writeFileSync(path.join(input.workspaceDir, `attempt-${input.attempt}.txt`), String(input.attempt));
				yield {
					type: "round",
					round: round({
						depth: 1,
						turn: 1,
						handoff_id: `h0000${input.attempt}-coder`,
						goal_id: "goal-1",
						lane: "code",
					}),
				};
			},
		};
		const { outDir, result, caseFile } = await runCustomBenchmark(
			driver,
			async (request: any) => (request.evaluationRunId.endsWith("--a1") ? "unresolved" : "resolved"),
			{ attempts: 2 },
		);
		expect(result.report.attempts_per_instance).toBe(2);
		expect(result.report.not_official).toBe(true);
		expect(caseFile.attempts.map((attempt: any) => attempt.attempt)).toEqual([1, 2]);
		expect(caseFile.attempts.map((attempt: any) => attempt.evaluation_run_id)).toEqual([
			"bench-20260821-000000-add--demo__demo-1001--a1",
			"bench-20260821-000000-add--demo__demo-1001--a2",
		]);
		expect(fs.readFileSync(path.join(outDir, "predictions.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
		expect(result.report.resolved).toEqual({ pass_at_1_mean: 0.5, pass_at_1_stderr: null, pass_at_n: 1 });
		expect(result.report.dispersion).toMatchObject({ verdict_flip_rate: 1 });
	});
});
