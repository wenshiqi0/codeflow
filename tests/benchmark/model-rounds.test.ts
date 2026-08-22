/**
 * Model-round counting (design §6, §13.4).
 *
 * One assistant response with usage is one completed round — regardless of how
 * many tool calls it carries. Failed provider attempts are not rounds. Every
 * role counts, including support models; support rounds are additionally
 * broken out. Rounds are derived from the usage ledger, never a transcript.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanupTmpDirs, loadBenchmarkModule } from "./helpers";

afterEach(cleanupTmpDirs);

const USAGE = {
	input: 10,
	output: 5,
	reasoning: 0,
	cache_read: 0,
	cache_write: 0,
	total_tokens: 15,
	cost: null,
};

function usageRecord(overrides: Record<string, unknown> = {}) {
	return {
		schema_version: 1,
		at: "2026-01-01T00:00:00Z",
		attempt: 1,
		role: "worker",
		provider: "fixture",
		model: "fixture-worker",
		handoff_id: null,
		goal_id: null,
		thread: null,
		usage: { ...USAGE },
		...overrides,
	};
}

function toolRow(callId: string, kind: "requested" | "result", extra: Record<string, unknown> = {}) {
	return {
		schema_version: 1,
		kind,
		call_id: callId,
		tool: "bash",
		status: kind === "result" ? "succeeded" : null,
		at: "2026-01-01T00:00:00Z",
		run_id: null,
		role: "worker",
		depth: 1,
		handoff_id: null,
		goal_id: null,
		thread: null,
		provider: "fixture",
		model: "fixture-worker",
		...extra,
	};
}

async function bench(): Promise<any> {
	return loadBenchmarkModule();
}

describe("round classification", () => {
	test("project rounds are primary; internal support models are single-listed", async () => {
		const mod = await bench();
		for (const role of ["worker", "future-worker"]) {
			expect(mod.classifyModelRole(role)).toBe("primary");
		}
		for (const role of mod.SUPPORT_MODEL_ROLES) {
			expect(mod.classifyModelRole(role)).toBe("support");
		}
		// An unknown role must still be counted (as primary), never dropped.
		expect(mod.classifyModelRole("some-future-role")).toBe("primary");
	});

	test("the support set contains only the internal zipper", async () => {
		const mod = await bench();
		expect(mod.SUPPORT_MODEL_ROLES).toEqual(["zipper"]);
	});
});

describe("round counting semantics", () => {
	test("one response with three tool calls is 1 model round + 3 tool calls", async () => {
		const mod = await bench();
		const metrics = mod.buildAttemptMetrics({
			usageRecords: [usageRecord()],
			failedModelAttempts: [],
			toolCallRecords: [
				toolRow("c1", "requested"),
				toolRow("c1", "result"),
				toolRow("c2", "requested"),
				toolRow("c2", "result", { status: "failed" }),
				toolRow("c3", "requested"),
				toolRow("c3", "result", { status: "rejected" }),
			],
			wallSeconds: 1,
			terminatedBy: null,
		});
		expect(metrics.model_rounds_total).toBe(1);
		expect(metrics.tool_calls_total).toBe(3);
		expect(metrics.tool_calls_per_model_round).toBe(3);
	});

	test("multi-worker attempt: total = primary + support; support broken out", async () => {
		const mod = await bench();
		const metrics = mod.buildAttemptMetrics({
			usageRecords: [
				usageRecord({ role: "worker", model: "fixture-worker" }),
				usageRecord({ role: "worker" }),
				usageRecord(),
				usageRecord({ role: "worker", model: "fixture-worker" }),
				usageRecord({ role: "zipper", model: "fixture-zipper" }),
			],
			failedModelAttempts: [],
			toolCallRecords: [],
			wallSeconds: 1,
			terminatedBy: null,
		});
		expect(metrics.model_rounds_total).toBe(5);
		expect(metrics.primary_model_rounds).toBe(4);
		expect(metrics.support_model_rounds).toBe(1);
	});

	test("failed provider attempts are counted separately, never as completed rounds", async () => {
		const mod = await bench();
		const metrics = mod.buildAttemptMetrics({
			usageRecords: [usageRecord(), usageRecord()],
			failedModelAttempts: [
				{
					schema_version: 1,
					at: "2026-01-01T00:00:00Z",
					role: "worker",
					provider: "fixture",
					model: "fixture-worker",
					error_class: "provider_timeout",
				},
				{
					schema_version: 1,
					at: "2026-01-01T00:00:01Z",
					role: "worker",
					provider: "fixture",
					model: "fixture-worker",
					error_class: "overloaded",
				},
			],
			toolCallRecords: [],
			wallSeconds: 1,
			terminatedBy: null,
		});
		expect(metrics.model_rounds_total).toBe(2);
		expect(metrics.failed_model_attempts).toBe(2);
		expect(metrics.primary_model_rounds + metrics.support_model_rounds).toBe(2);
	});

	test("rounds derive from the usage ledger row count", async () => {
		const mod = await bench();
		const metrics = mod.buildAttemptMetrics({
			usageRecords: [usageRecord(), usageRecord(), usageRecord()],
			failedModelAttempts: [],
			toolCallRecords: [],
			wallSeconds: 1,
			terminatedBy: null,
		});
		// One assistant usage row == one completed round (design §6); no
		// transcript parsing may change that.
		expect(metrics.model_rounds_total).toBe(3);
	});

	test("zero rounds leave tool_calls_per_model_round null, not NaN or Infinity", async () => {
		const mod = await bench();
		const metrics = mod.buildAttemptMetrics({
			usageRecords: [],
			failedModelAttempts: [],
			toolCallRecords: [],
			wallSeconds: 0,
			terminatedBy: null,
		});
		expect(metrics.model_rounds_total).toBe(0);
		expect(metrics.tool_calls_per_model_round).toBeNull();
	});
});
