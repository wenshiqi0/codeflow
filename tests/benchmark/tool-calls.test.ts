/**
 * Tool-call counting and the privacy-safe ledger (design §7, §13.5).
 *
 * Top-level calls dedup by id; a multi-command bash call stays one call;
 * rejected/errored/incomplete calls still count. The ledger may hold only
 * id/name/status/timestamps/attribution — where attribution includes role
 * AND provider/model (design §7 “by role、provider/model、goal/lane”) so
 * by-model counts never need role→model inference — and never arguments,
 * command text, results, source, or credentials. The append path must refuse
 * anything else. Cross-cutting attribution/privacy business cases live in
 * tool-attribution.test.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTmpDirs, loadBenchmarkModule, makeTmpDir } from "./helpers";

afterEach(cleanupTmpDirs);

async function bench(): Promise<any> {
	return loadBenchmarkModule();
}

/** A row per the target contract: attribution includes provider/model (§7). */
function row(callId: string, kind: "requested" | "result", extra: Record<string, unknown> = {}) {
	return {
		schema_version: 1,
		kind,
		call_id: callId,
		tool: "bash",
		status: kind === "result" ? "succeeded" : null,
		at: "2026-01-01T00:00:00Z",
		run_id: "run-x",
		role: "coder",
		depth: 1,
		handoff_id: "h1",
		goal_id: "g1",
		lane: "code",
		provider: "fixture",
		model: "fixture-coder",
		...extra,
	};
}

describe("counting semantics", () => {
	test("requested = completed + incomplete; statuses classified", async () => {
		const mod = await bench();
		const summary = mod.summarizeToolCalls([
			row("c1", "requested"),
			row("c1", "result"),
			row("c2", "requested"),
			row("c2", "result", { status: "failed" }),
			row("c3", "requested"),
			row("c3", "result", { status: "rejected" }),
			row("c4", "requested"), // process ended with no terminal result
		]);
		expect(summary.total).toBe(4);
		expect(summary.requested).toBe(4);
		expect(summary.completed).toBe(3);
		expect(summary.succeeded).toBe(1);
		expect(summary.failed).toBe(1);
		expect(summary.rejected).toBe(1);
		expect(summary.incomplete).toBe(1);
		expect(summary.requested).toBe(summary.completed + summary.incomplete);
		expect(summary.by_tool).toEqual({ bash: 4 });
	});

	test("dedup by call id: repeated rows for one id are one call", async () => {
		const mod = await bench();
		const summary = mod.summarizeToolCalls([
			row("c1", "requested"),
			row("c1", "requested"),
			row("c1", "result"),
			row("c1", "result"),
			row("c2", "requested"),
			row("c2", "result", { status: "failed" }),
		]);
		expect(summary.total).toBe(2);
		expect(summary.succeeded).toBe(1);
		expect(summary.failed).toBe(1);
	});

	test("a multi-command bash call is exactly one tool call", async () => {
		// The ledger cannot even represent command text, so no shell parsing can
		// manufacture sub-call counts. One call id that "ran three commands"
		// (in the driver's reality) is one row pair here.
		const mod = await bench();
		const summary = mod.summarizeToolCalls([
			row("multi-cmd-1", "requested"),
			row("multi-cmd-1", "result"),
		]);
		expect(summary.total).toBe(1);
		expect(summary.by_tool.bash).toBe(1);
		expect(JSON.stringify(summary)).not.toMatch(/command|shell|subcall/i);
	});

	test("a retry is a new call id and therefore a new call", async () => {
		const mod = await bench();
		const summary = mod.summarizeToolCalls([
			row("t1", "requested"),
			row("t1", "result", { status: "failed" }),
			row("t2", "requested", { tool: "bash" }),
			row("t2", "result"),
		]);
		expect(summary.total).toBe(2);
		expect(summary.failed).toBe(1);
		expect(summary.succeeded).toBe(1);
	});
});

describe("ledger privacy and attribution", () => {
	test("the allowed field set is exactly id/name/status/timestamps/attribution incl. provider/model", async () => {
		const mod = await bench();
		expect([...mod.TOOL_CALL_RECORD_FIELDS].sort()).toEqual([
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
	});

	test("provider and model are required, non-empty strings (§7 by provider/model)", async () => {
		const mod = await bench();
		expect(mod.validateToolCallRecord(row("c1", "result"))).toEqual([]);
		const missingProvider = row("c1", "result");
		delete missingProvider.provider;
		expect(mod.validateToolCallRecord(missingProvider).join(" ")).toContain("provider");
		const missingModel = row("c1", "result");
		delete missingModel.model;
		expect(mod.validateToolCallRecord(missingModel).join(" ")).toContain("model");
		const badTypes = mod.validateToolCallRecord(row("c1", "result", { provider: "", model: 7 }));
		expect(badTypes.join(" ")).toContain("provider");
		expect(badTypes.join(" ")).toContain("model");
	});

	test("validateToolCallRecord flags params, command text, results, and secrets", async () => {
		const mod = await bench();
		const forbidden = [
			{ key: "arguments", value: { command: "cat /etc/passwd" } },
			{ key: "command", value: "grep GOLD .codeflow" },
			{ key: "params", value: { path: "fix.py" } },
			{ key: "result", value: "diff --git a/fix.py" },
			{ key: "output", value: "CANARY_TEST_PATCH" },
			{ key: "content", value: "def fix(): ..." },
			{ key: "api_key", value: "sk-secret" },
		];
		for (const { key, value } of forbidden) {
			const violations = mod.validateToolCallRecord({ ...row("c1", "result"), [key]: value });
			expect(violations.length).toBeGreaterThan(0);
			expect(violations.join(" ")).toContain(key);
		}
		// A clean attributed row passes.
		expect(mod.validateToolCallRecord(row("c1", "result"))).toEqual([]);
		// A requested row must not carry a terminal status.
		expect(
			mod.validateToolCallRecord(row("c1", "requested", { status: "succeeded" })).length,
		).toBeGreaterThan(0);
	});

	test("appendToolCallRecord refuses an un-attributed row — no attribution, no ledger write", async () => {
		const mod = await bench();
		const file = path.join(makeTmpDir(), "tool-calls.jsonl");
		const unattributed = row("c1", "requested");
		delete unattributed.provider;
		delete unattributed.model;
		expect(() => mod.appendToolCallRecord(file, unattributed)).toThrow();
		expect(fs.existsSync(file)).toBe(false);
	});

	test("appendToolCallRecord refuses a record with payloads — the write path enforces privacy", async () => {
		const mod = await bench();
		const file = path.join(makeTmpDir(), "tool-calls.jsonl");
		expect(() =>
			mod.appendToolCallRecord(file, row("c1", "result", { command: "rm -rf /" })),
		).toThrow();
		expect(fs.existsSync(file)).toBe(false);
		mod.appendToolCallRecord(file, row("c1", "requested"));
		mod.appendToolCallRecord(file, row("c1", "result"));
		const readBack = mod.readToolCallRecords(file);
		expect(readBack).toHaveLength(2);
		expect(readBack[0].call_id).toBe("c1");
	});
});
