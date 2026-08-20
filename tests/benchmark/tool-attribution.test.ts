/**
 * Direct provider/model attribution on tool-call records and reporting
 * (design §7, §11, §13.5).
 *
 * Load-bearing properties:
 * - Every tool-call ledger row carries explicit `provider` + `model` sourced
 *   from the context that EMITTED the call (the assistant response — the same
 *   attribution the usage/round ledger records), alongside role and
 *   goal/lane attribution, for root and delegated roles alike.
 * - Report by-model tool counts are computed from those recorded fields,
 *   never from a role→model inference. A role that used several models in an
 *   attempt must still get exact per-model tool counts; a role whose usage
 *   ledger lost a round (budget stop between flushes) must never have its
 *   calls reassigned to whatever model the usage rows happen to show.
 * - The privacy floor is untouched: tool arguments, command text, tool
 *   results, source content, and credentials appear nowhere in any tool-call
 *   ledger or in report.json — the extension is fed realistic payloads
 *   (`input.command`, `result.stdout`) and the artifacts are deep-scanned.
 * - Counting semantics (multi-call response, retry, rejected/error/
 *   cancelled/incomplete, dedup by call id) are preserved on attributed rows.
 *
 * Red today: rows have no provider/model fields, the runner does not stamp
 * them, the production driver does not forward them, and the report infers
 * by-model tool counts from a role→model map (ambiguous roles are silently
 * dropped). These tests pin the target contract; see tests/benchmark/
 * TESTPLAN.md rows ATTR-*.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	baseEnv,
	cleanupTmpDirs,
	FIXTURE_DRIVER_DIR,
	loadBenchmarkModule,
	makeTmpDir,
	REPO,
	SNAPSHOT,
} from "./helpers";

afterEach(cleanupTmpDirs);

async function bench(): Promise<any> {
	return loadBenchmarkModule();
}

const LEDGER_EXT = path.join(REPO, "runtime", "extensions", "benchmark-ledger", "index.ts");
const DRIVER_SCRIPT = path.join(REPO, "runtime", "scripts", "benchmark", "codeflow-driver.ts");
const FAKE_INNER = path.join(REPO, "tests", "benchmark", "fakes", "inner-codeflow.sh");

// --------------------------------------------------------------------------
// Shared helpers
// --------------------------------------------------------------------------

/** A fully attributed row per the target contract (§7 + provider/model). */
function attributedRow(
	callId: string,
	kind: "requested" | "result",
	extra: Record<string, unknown> = {},
) {
	return {
		schema_version: 1,
		kind,
		call_id: callId,
		tool: "bash",
		status: kind === "result" ? "succeeded" : null,
		at: "2026-01-01T00:00:00Z",
		run_id: "run-attr",
		role: "coder",
		depth: 1,
		handoff_id: "h1",
		goal_id: "g1",
		lane: "code",
		provider: "prov-x",
		model: "model-x",
		...extra,
	};
}

/** Keys no tool-call row or report object may carry at any depth. */
const FORBIDDEN_TOOLCALL_KEYS: ReadonlySet<string> = new Set([
	"arguments",
	"args",
	"params",
	"parameter",
	"input",
	"command",
	"cmd",
	"script",
	"result",
	"results",
	"output",
	"stdout",
	"stderr",
	"response",
	"content",
	"body",
	"source",
	"source_code",
	"code",
	"patch",
	"diff",
	"api_key",
	"apikey",
	"secret",
	"secrets",
	"password",
	"credential",
	"credentials",
	"authorization",
	"auth",
]);

/** Payload canaries fed to the emitters; they must never serialize anywhere. */
const CANARY_COMMAND = "cat /etc/ATTR_CANARY_COMMAND_TEXT";
const CANARY_RESULT = "ATTR_CANARY_TOOL_RESULT_OUTPUT";

function deepKeys(value: unknown, keys: Set<string> = new Set()): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) deepKeys(item, keys);
		return keys;
	}
	if (typeof value === "object" && value !== null) {
		for (const [key, child] of Object.entries(value)) {
			keys.add(key);
			deepKeys(child, keys);
		}
	}
	return keys;
}

function forbiddenKeysIn(value: unknown): string[] {
	return [...FORBIDDEN_TOOLCALL_KEYS].filter((key) => deepKeys(value).has(key));
}

/**
 * Report maps whose KEYS are run-chosen identifiers (role/model/lane/tool
 * names — a lane can legitimately be called "code"). Their keys are exempt
 * from the payload-name scan; their VALUES are scanned like everything else.
 */
const REPORT_DYNAMIC_KEY_MAPS: ReadonlySet<string> = new Set([
	"breakdowns.by_role",
	"breakdowns.by_model",
	"breakdowns.by_lane",
	"breakdowns.by_tool",
]);

function deepReportKeys(
	value: unknown,
	keys: Set<string> = new Set(),
	path: readonly string[] = [],
): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) deepReportKeys(item, keys, path);
		return keys;
	}
	if (typeof value === "object" && value !== null) {
		const suppressOwnKeys = REPORT_DYNAMIC_KEY_MAPS.has(path.join("."));
		for (const [key, child] of Object.entries(value)) {
			if (!suppressOwnKeys) keys.add(key);
			deepReportKeys(child, keys, [...path, key]);
		}
	}
	return keys;
}

function forbiddenReportKeysIn(value: unknown): string[] {
	return [...FORBIDDEN_TOOLCALL_KEYS].filter((key) => deepReportKeys(value).has(key));
}

function readJsonlFile(file: string): any[] {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

/** Set env vars for a synchronous body, restoring the previous state after. */
function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
	const saved = new Map<string, string | undefined>();
	for (const key of Object.keys(vars)) saved.set(key, process.env[key]);
	for (const [key, value] of Object.entries(vars)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		body();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/** Minimal ExtensionAPI: capture handlers, fire them synchronously. */
function fakePi(): { handlers: Map<string, (event: any) => void>; pi: any } {
	const handlers = new Map<string, (event: any) => void>();
	const pi = {
		on(event: string, handler: (event: any) => void) {
			handlers.set(event, handler);
		},
	};
	return { handlers, pi };
}

function fireMessageEnd(
	handlers: Map<string, (event: any) => void>,
	provider: string,
	model: string,
	withUsage = true,
): void {
	handlers.get("message_end")!({
		type: "message_end",
		message: assistantMessage(provider, model, withUsage),
	});
}

function assistantMessage(provider: string, model: string, withUsage: boolean): Record<string, unknown> {
	const message: Record<string, unknown> = {
		role: "assistant",
		provider,
		model,
		responseModel: model,
		timestamp: Date.parse("2026-01-01T00:00:00Z"),
		stopReason: null,
	};
	if (withUsage) message.usage = { input: 10, output: 5, reasoning: 0, totalTokens: 15 };
	return message;
}

function fireToolCall(handlers: Map<string, (event: any) => void>, callId: string, tool = "bash"): void {
	handlers.get("tool_call")!({
		type: "tool_call",
		toolCallId: callId,
		toolName: tool,
		input: { command: CANARY_COMMAND, api_key_hint: "redacted-by-contract" },
	});
}

function fireToolEnd(
	handlers: Map<string, (event: any) => void>,
	callId: string,
	isError: boolean,
	tool = "bash",
): void {
	handlers.get("tool_execution_end")!({
		type: "tool_execution_end",
		toolCallId: callId,
		toolName: tool,
		result: { stdout: CANARY_RESULT },
		isError,
	});
}

/**
 * Load the REAL benchmark-ledger extension, wire it to a fake pi under the
 * given benchmark env, and run the scripted event sequence synchronously
 * inside that env (the extension reads attribution env lazily per row).
 */
async function withExtension(
	ledger: string,
	roleEnv: Record<string, string | undefined>,
	body: (handlers: Map<string, (event: any) => void>) => void,
): Promise<void> {
	const mod = await import(LEDGER_EXT);
	const { handlers, pi } = fakePi();
	withEnv(
		{
			CODEFLOW_BENCHMARK_DRIVER_LEDGER_DIR: ledger,
			CODEFLOW_BENCHMARK_ATTEMPT: "1",
			CODEFLOW_RUN_ID: "run-ext",
			CODEFLOW_AGENT_ROLE: roleEnv.CODEFLOW_AGENT_ROLE ?? "planner",
			CODEFLOW_AGENT_DEPTH: roleEnv.CODEFLOW_AGENT_DEPTH ?? "0",
			CODEFLOW_HANDOFF_ID: roleEnv.CODEFLOW_HANDOFF_ID ?? undefined,
			CODEFLOW_GOAL_ID: roleEnv.CODEFLOW_GOAL_ID ?? undefined,
			CODEFLOW_LANE: roleEnv.CODEFLOW_LANE ?? undefined,
		},
		() => {
			(mod.default as (api: any) => void)(pi);
			body(handlers);
		},
	);
}

// --------------------------------------------------------------------------
// ATTR — the ledger schema itself
// --------------------------------------------------------------------------

describe("ATTR: the tool-call contract carries provider/model attribution", () => {
	test("ATTR-1 provider and model are part of the allowed field set", async () => {
		const mod = await bench();
		const fields = [...mod.TOOL_CALL_RECORD_FIELDS];
		expect(fields).toContain("provider");
		expect(fields).toContain("model");
	});

	test("ATTR-2 validateToolCallRecord requires non-empty string provider and model", async () => {
		const mod = await bench();
		// A fully attributed row is clean.
		expect(mod.validateToolCallRecord(attributedRow("c1", "result"))).toEqual([]);
		// Missing fields are violations that name the field.
		const missingProvider = attributedRow("c1", "result");
		delete missingProvider.provider;
		expect(mod.validateToolCallRecord(missingProvider).join(" ")).toContain("provider");
		const missingModel = attributedRow("c1", "result");
		delete missingModel.model;
		expect(mod.validateToolCallRecord(missingModel).join(" ")).toContain("model");
		// Empty or non-string values are violations.
		const violations = mod.validateToolCallRecord(
			attributedRow("c1", "result", { provider: "", model: 7 }),
		);
		expect(violations.join(" ")).toContain("provider");
		expect(violations.join(" ")).toContain("model");
	});

	test("ATTR-3 the write path refuses un-attributed rows; attributed rows round-trip", async () => {
		const mod = await bench();
		const file = path.join(makeTmpDir(), "tool-calls.jsonl");
		const unattributed = attributedRow("c1", "requested");
		delete unattributed.provider;
		delete unattributed.model;
		expect(() => mod.appendToolCallRecord(file, unattributed)).toThrow();
		expect(fs.existsSync(file)).toBe(false);
		mod.appendToolCallRecord(file, attributedRow("c1", "requested"));
		mod.appendToolCallRecord(file, attributedRow("c1", "result"));
		const readBack = mod.readToolCallRecords(file);
		expect(readBack).toHaveLength(2);
		expect(readBack[0].provider).toBe("prov-x");
		expect(readBack[0].model).toBe("model-x");
		expect(readBack[1].provider).toBe("prov-x");
		expect(readBack[1].model).toBe("model-x");
	});

	test("ATTR-4 privacy floor: payload keys stay refused on attributed rows", async () => {
		const mod = await bench();
		const payloads = [
			{ key: "arguments", value: { command: "grep GOLD" } },
			{ key: "input", value: { command: "cat /etc/passwd" } },
			{ key: "result", value: "diff --git a/fix.py" },
			{ key: "stdout", value: "raw tool output" },
			{ key: "source", value: "def fix(): ..." },
			{ key: "api_key", value: "sk-fake" },
		];
		for (const { key, value } of payloads) {
			const violations = mod.validateToolCallRecord(attributedRow("c1", "result", { [key]: value }));
			expect(violations.join(" ")).toContain(key);
		}
	});
});

// --------------------------------------------------------------------------
// EXT — the real extension stamps rows with the emitting context
// --------------------------------------------------------------------------

describe("EXT: benchmark-ledger attributes tool calls to the emitting model", () => {
	test("EXT-1 root role rows carry the assistant response's provider/model next to role attribution", async () => {
		const ledger = path.join(makeTmpDir(), "staging");
		await withExtension(ledger, { CODEFLOW_AGENT_ROLE: "planner", CODEFLOW_AGENT_DEPTH: "0" }, (handlers) => {
			fireMessageEnd(handlers, "prov-a", "model-a");
			fireToolCall(handlers, "tc-1");
			fireToolEnd(handlers, "tc-1", false);
		});

		const rows = readJsonlFile(path.join(ledger, "tool-calls.jsonl"));
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.provider).toBe("prov-a");
			expect(row.model).toBe("model-a");
			expect(row.role).toBe("planner");
			expect(row.depth).toBe(0);
			expect(row.run_id).toBe("run-ext");
			expect(row.goal_id).toBeNull();
			expect(row.lane).toBeNull();
		}
		expect(rows[0].kind).toBe("requested");
		expect(rows[1].kind).toBe("result");
	});

	test("EXT-2 a multi-model role attributes each call to the model that emitted it", async () => {
		const ledger = path.join(makeTmpDir(), "staging");
		await withExtension(ledger, { CODEFLOW_AGENT_ROLE: "coder", CODEFLOW_AGENT_DEPTH: "1" }, (handlers) => {
			fireMessageEnd(handlers, "prov-a", "model-a");
			fireToolCall(handlers, "mc-1");
			// Same role, a second response on a different model.
			fireMessageEnd(handlers, "prov-a", "model-b");
			fireToolCall(handlers, "mc-2");
			// mc-1's result lands AFTER model-b responded: it still belongs
			// to model-a, the context that emitted the call.
			fireToolEnd(handlers, "mc-1", false);
			fireToolEnd(handlers, "mc-2", true);
		});

		const rows = readJsonlFile(path.join(ledger, "tool-calls.jsonl"));
		const byCall = new Map<string, any[]>();
		for (const row of rows) {
			const list = byCall.get(row.call_id) ?? [];
			list.push(row);
			byCall.set(row.call_id, list);
		}
		expect(byCall.get("mc-1")).toHaveLength(2);
		expect(byCall.get("mc-2")).toHaveLength(2);
		for (const row of byCall.get("mc-1")!) {
			expect(row.model).toBe("model-a");
		}
		for (const row of byCall.get("mc-2")!) {
			expect(row.model).toBe("model-b");
		}
		expect(byCall.get("mc-2")![1].status).toBe("failed");
	});

	test("EXT-3 delegated role keeps goal/lane attribution alongside provider/model", async () => {
		const ledger = path.join(makeTmpDir(), "staging");
		await withExtension(
			ledger,
			{
				CODEFLOW_AGENT_ROLE: "coder",
				CODEFLOW_AGENT_DEPTH: "1",
				CODEFLOW_HANDOFF_ID: "h-77",
				CODEFLOW_GOAL_ID: "g-attr",
				CODEFLOW_LANE: "code",
			},
			(handlers) => {
				fireMessageEnd(handlers, "prov-d", "model-delegated");
				fireToolCall(handlers, "dg-1", "read");
				fireToolEnd(handlers, "dg-1", false, "read");
			},
		);

		const rows = readJsonlFile(path.join(ledger, "tool-calls.jsonl"));
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.role).toBe("coder");
			expect(row.depth).toBe(1);
			expect(row.handoff_id).toBe("h-77");
			expect(row.goal_id).toBe("g-attr");
			expect(row.lane).toBe("code");
			expect(row.provider).toBe("prov-d");
			expect(row.model).toBe("model-delegated");
		}
	});

	test("EXT-4 a tool call with no prior assistant context still records non-empty attribution", async () => {
		const ledger = path.join(makeTmpDir(), "staging");
		await withExtension(ledger, {}, (handlers) => {
			// No message_end fired first — the row must never crash or carry
			// empty attribution (the call must stay countable and attributable).
			expect(() => fireToolCall(handlers, "orphan-1")).not.toThrow();
		});
		const rows = readJsonlFile(path.join(ledger, "tool-calls.jsonl"));
		expect(rows).toHaveLength(1);
		expect(typeof rows[0].provider).toBe("string");
		expect(rows[0].provider.length).toBeGreaterThan(0);
		expect(typeof rows[0].model).toBe("string");
		expect(rows[0].model.length).toBeGreaterThan(0);
	});

	test("EXT-5 usage-less assistant messages stay failed attempts, not rounds or calls", async () => {
		const ledger = path.join(makeTmpDir(), "staging");
		await withExtension(ledger, { CODEFLOW_AGENT_ROLE: "coder", CODEFLOW_AGENT_DEPTH: "1" }, (handlers) => {
			fireMessageEnd(handlers, "prov-a", "model-a", false);
		});
		const failed = readJsonlFile(path.join(ledger, "failed-model-attempts.jsonl"));
		expect(failed).toHaveLength(1);
		expect(failed[0].provider).toBe("prov-a");
		expect(failed[0].model).toBe("model-a");
		expect(readJsonlFile(path.join(ledger, "tool-calls.jsonl"))).toHaveLength(0);
		expect(readJsonlFile(path.join(ledger, "usage.jsonl"))).toHaveLength(0);
	});

	test("EXT-6 the staging ledger never stores tool arguments, results, or secrets", async () => {
		const ledger = path.join(makeTmpDir(), "staging");
		await withExtension(ledger, { CODEFLOW_AGENT_ROLE: "coder", CODEFLOW_AGENT_DEPTH: "1" }, (handlers) => {
			fireMessageEnd(handlers, "prov-a", "model-a");
			fireToolCall(handlers, "pv-1");
			fireToolEnd(handlers, "pv-1", true);
		});

		const toolRows = readJsonlFile(path.join(ledger, "tool-calls.jsonl"));
		expect(toolRows).toHaveLength(2);
		for (const row of toolRows) {
			expect(forbiddenKeysIn(row)).toEqual([]);
		}
		// Payload canaries fed through the events appear nowhere in any file
		// (a file the emitter never needed is simply absent).
		for (const name of ["tool-calls.jsonl", "usage.jsonl", "failed-model-attempts.jsonl"]) {
			const file = path.join(ledger, name);
			if (!fs.existsSync(file)) continue;
			const raw = fs.readFileSync(file, "utf8");
			expect(raw).not.toContain(CANARY_COMMAND);
			expect(raw).not.toContain(CANARY_RESULT);
		}
	});
});

// --------------------------------------------------------------------------
// RUN — the runner stamps per-attempt ledger rows from the driver events
// --------------------------------------------------------------------------

function usage(totalTokens = 100): any {
	return {
		input: totalTokens - 10,
		output: 10,
		reasoning: 0,
		cache_read: 0,
		cache_write: 0,
		total_tokens: totalTokens,
		cost: null,
	};
}

/**
 * Four rounds: root planner, a coder on model-a, the SAME coder on model-b,
 * and a delegated tester — every round carrying its own tool calls.
 */
function attributedRoundsDriver() {
	return {
		startAttempt(_input: any) {
			return (async function* () {
				yield {
					type: "round",
					round: {
						role: "planner",
						provider: "p1",
						model: "plan-a",
						handoff_id: null,
						goal_id: null,
						lane: null,
						usage: usage(100),
						tool_calls: [{ call_id: "p1a", tool: "bash", status: "succeeded" }],
					},
				};
				yield {
					type: "round",
					round: {
						role: "coder",
						provider: "p2",
						model: "code-a",
						handoff_id: "h1",
						goal_id: "g1",
						lane: "code",
						usage: usage(100),
						tool_calls: [
							{ call_id: "c1a", tool: "bash", status: "succeeded" },
							{ call_id: "c1b", tool: "bash", status: "failed" },
						],
					},
				};
				// The same coder role switches models mid-attempt.
				yield {
					type: "round",
					round: {
						role: "coder",
						provider: "p2",
						model: "code-b",
						handoff_id: "h1",
						goal_id: "g1",
						lane: "code",
						usage: usage(100),
						tool_calls: [
							{ call_id: "c2a", tool: "bash", status: "rejected" },
							{ call_id: "c2b", tool: "bash", status: "incomplete" },
						],
					},
				};
				yield {
					type: "round",
					round: {
						role: "tester",
						provider: "p3",
						model: "test-a",
						handoff_id: "h2",
						goal_id: "g1",
						lane: "test",
						usage: usage(100),
						tool_calls: [{ call_id: "t1a", tool: "read", status: "succeeded" }],
					},
				};
				yield { type: "workspace_write", path: "fix.py", content: "def fix():\n    return 1\n" };
			})();
		},
	};
}

/** Expected (provider, model, role, goal, lane) per call id in the scenario. */
const EXPECTED_CALL_ATTRIBUTION: Record<
	string,
	[string, string, string, string | null, string | null]
> = {
	p1a: ["p1", "plan-a", "planner", null, null],
	c1a: ["p2", "code-a", "coder", "g1", "code"],
	c1b: ["p2", "code-a", "coder", "g1", "code"],
	c2a: ["p2", "code-b", "coder", "g1", "code"],
	c2b: ["p2", "code-b", "coder", "g1", "code"],
	t1a: ["p3", "test-a", "tester", "g1", "test"],
};

async function runWithDriver(driver: any): Promise<string> {
	const mod = await bench();
	const outDir = makeTmpDir();
	await mod.runBenchmark({
		dataset: SNAPSHOT,
		instances: ["demo/demo-1001"],
		outDir,
		driver,
		evaluator: { async evaluate() { return "resolved"; } },
		clock: { now: () => 0 },
		codeflowCommit: "0".repeat(40),
	});
	return outDir;
}

function attemptToolRows(outDir: string, instance = "demo/demo-1001"): any[] {
	return readJsonlFile(path.join(outDir, "cases", instance.replace(/\//g, "__"), "attempts", "1", "tool-calls.jsonl"));
}

describe("RUN: the runner writes attributed rows into the per-attempt ledger", () => {
	test("RUN-1 round-attached calls carry the emitting round's provider/model and goal/lane", async () => {
		const outDir = await runWithDriver(attributedRoundsDriver());
		const rows = attemptToolRows(outDir);
		expect(rows.length).toBeGreaterThanOrEqual(10); // 6 calls, 5 with result rows
		const seen = new Set<string>();
		for (const row of rows) {
			const expected = EXPECTED_CALL_ATTRIBUTION[row.call_id];
			expect(expected).toBeDefined();
			const [provider, model, role, goalId, lane] = expected;
			expect(row.provider).toBe(provider);
			expect(row.model).toBe(model);
			expect(row.role).toBe(role);
			expect(row.goal_id).toBe(goalId);
			expect(row.lane).toBe(lane);
			seen.add(row.call_id);
		}
		expect([...seen].sort()).toEqual([...Object.keys(EXPECTED_CALL_ATTRIBUTION)].sort());
	});

	test("RUN-2 standalone tool_calls events carry provider/model through to the ledger", async () => {
		const driver = {
			startAttempt(_input: any) {
				return (async function* () {
					yield {
						type: "round",
						round: {
							role: "coder",
							provider: "p2",
							model: "code-a",
							handoff_id: "h9",
							goal_id: "g2",
							lane: "review",
							usage: usage(100),
						},
					};
					// Real-mode instrumentation: calls terminate between rounds
					// as standalone events, attributed like their staging rows.
					yield {
						type: "tool_calls",
						role: "coder",
						provider: "p2",
						model: "code-a",
						handoff_id: "h9",
						goal_id: "g2",
						lane: "review",
						calls: [
							{ call_id: "s1", tool: "bash", status: "succeeded" },
							{ call_id: "s2", tool: "bash", status: "incomplete" },
						],
					};
					yield { type: "workspace_write", path: "fix.py", content: "x = 1\n" };
				})();
			},
		};
		const outDir = await runWithDriver(driver);
		const rows = attemptToolRows(outDir);
		const byCall = new Map<string, any[]>();
		for (const row of rows) {
			const list = byCall.get(row.call_id) ?? [];
			list.push(row);
			byCall.set(row.call_id, list);
		}
		expect([...byCall.keys()].sort()).toEqual(["s1", "s2"]);
		for (const row of byCall.get("s1")!) {
			expect(row.provider).toBe("p2");
			expect(row.model).toBe("code-a");
			expect(row.role).toBe("coder");
			expect(row.goal_id).toBe("g2");
			expect(row.lane).toBe("review");
		}
		// s2 never terminated: exactly one requested row, still attributed.
		const s2 = byCall.get("s2")!;
		expect(s2).toHaveLength(1);
		expect(s2[0].kind).toBe("requested");
		expect(s2[0].provider).toBe("p2");
		expect(s2[0].model).toBe("code-a");
	});

	test("RUN-3 counting semantics hold on attributed rows (multi-call, retry, cancelled)", async () => {
		const driver = {
			startAttempt(_input: any) {
				return (async function* () {
					yield {
						type: "round",
						round: {
							// One response, three tool calls: multi-call stays 3 calls.
							role: "coder",
							provider: "p2",
							model: "code-a",
							handoff_id: null,
							goal_id: null,
							lane: null,
							usage: usage(100),
							tool_calls: [
								{ call_id: "m1", tool: "bash", status: "succeeded" },
								{ call_id: "m2", tool: "bash", status: "failed" },
								{ call_id: "m3", tool: "bash", status: "rejected" },
							],
						},
					};
					yield {
						type: "round",
						round: {
							// A retry of the failed call is a NEW id: a new call.
							role: "coder",
							provider: "p2",
							model: "code-a",
							handoff_id: null,
							goal_id: null,
							lane: null,
							usage: usage(100),
							tool_calls: [{ call_id: "m4", tool: "bash", status: "succeeded" }],
						},
					};
					yield {
						type: "round",
						round: {
							// Started, never terminated before process end.
							role: "coder",
							provider: "p2",
							model: "code-a",
							handoff_id: null,
							goal_id: null,
							lane: null,
							usage: usage(100),
							tool_calls: [{ call_id: "m5", tool: "bash", status: "incomplete" }],
						},
					};
					yield { type: "workspace_write", path: "fix.py", content: "y = 2\n" };
				})();
			},
		};
		const outDir = await runWithDriver(driver);
		const caseFile = JSON.parse(
			fs.readFileSync(path.join(outDir, "cases", "demo__demo-1001", "case.json"), "utf8"),
		);
		const metrics = caseFile.attempts[0].metrics;
		expect(metrics.model_rounds_total).toBe(3);
		expect(metrics.tool_calls_total).toBe(5);
		expect(metrics.tool_call_counts).toEqual({
			requested: 5,
			completed: 4,
			succeeded: 2,
			failed: 1,
			rejected: 1,
			incomplete: 1,
		});
		expect(metrics.tool_calls_by_tool).toEqual({ bash: 5 });
	});
});

// --------------------------------------------------------------------------
// CHAIN — the production driver forwards staging attribution as events
// --------------------------------------------------------------------------

describe("CHAIN: the production driver forwards provider/model on tool events", () => {
	test("CHAIN-1 standalone tool_calls events carry the staging rows' provider/model", async () => {
		const root = makeTmpDir("codeflow-bench-attr-chain-");
		const capture = path.join(root, "capture");
		const workspace = path.join(root, "cases", "demo__demo-1", "attempts", "1", "workspace");
		fs.mkdirSync(workspace, { recursive: true });
		const env: Record<string, string> = {
			...baseEnv(),
			CODEFLOW_BENCHMARK_CODEFLOW_BIN: FAKE_INNER,
			FAKE_INNER_CAPTURE_DIR: capture,
			FAKE_INNER_MODE: "scripted",
		};
		const child = Bun.spawn(
			[process.execPath, DRIVER_SCRIPT, "--workspace", workspace, "--attempt", "1", "--model-config", "default"],
			{ stdin: "pipe", stdout: "pipe", stderr: "pipe", env },
		);
		child.stdin!.write(
			`${JSON.stringify({
				instance_id: "demo/demo-1",
				repo: "demo/repo",
				base_commit: "a".repeat(40),
				problem_statement: "ATTR-CHAIN problem statement",
			})}\n`,
		);
		child.stdin!.end();

		const events: any[] = [];
		const decoder = new TextDecoder();
		let buffer = "";
		const reader = child.stdout!.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line.trim().length > 0) events.push(JSON.parse(line));
					newline = buffer.indexOf("\n");
				}
			}
		} finally {
			try {
				await reader.cancel();
			} catch {
				/* stream closed with the process */
			}
		}
		const exitCode = await child.exited;

		expect(exitCode).toBe(0);
		expect(events.map((event) => event.type)).toEqual(["round", "tool_calls", "round", "tool_calls"]);
		// The fake inner writes staging rows for fake-anthropic/fake-coder;
		// the driver must forward that attribution on every tool event.
		for (const event of events.filter((event) => event.type === "tool_calls")) {
			expect(event.provider).toBe("fake-anthropic");
			expect(event.model).toBe("fake-coder");
			expect(event.role).toBe("coder");
		}
		// Rounds already carry provider/model (the usage-ledger attribution).
		expect(events[0].round.provider).toBe("fake-anthropic");
		expect(events[0].round.model).toBe("fake-coder");
	}, 30_000);
});

// --------------------------------------------------------------------------
// CNT — by-model tool counts come from recorded fields, never role inference
// --------------------------------------------------------------------------

function handBuiltOutDir(dir: string, cases: Array<{ id: string; usage: any[]; tools: any[] }>): void {
	const ids = cases.map((c) => c.id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "benchmark-run.json"),
		JSON.stringify({
			schema_version: 1,
			benchmark_run_id: "bench-20260819-000000-attr",
			created_at: "2026-08-19T00:00:00Z",
			dataset: {
				dataset_id: "SWE-bench/SWE-bench_Verified",
				split: "test",
				revision: "78f471bf655a3137b2e8a75af1501690ec009ec3",
				source: "local-snapshot",
				instance_count: ids.length,
			},
			instances: { allowlist: null, selected: ids },
			harness: { commit: "7a21e05772954cc81471ae19d56f436cecf43c54" },
			codeflow_commit: "6ce5819dcb5cf5d472ebb5c99b8ae32f42760f7a",
			model_config: "test-config",
			concurrency: 1,
			tool_network: "disabled",
			model_provider_network: "disabled",
			budgets: {
				defaults: { model_rounds: 120, tool_calls: 400, total_tokens: 3000000, wall_seconds: 5400 },
				overrides: null,
				effective: {
					model_rounds: 120,
					tool_calls: 400,
					total_tokens: 3000000,
					wall_seconds: 5400,
				},
			},
			driver_mode: "fixture",
		}),
	);
	fs.writeFileSync(
		path.join(dir, "predictions.jsonl"),
		cases
			.map((c) =>
				JSON.stringify({
					instance_id: c.id,
					model_name_or_path: "fixture/fake-model",
					model_patch: "diff --git a/fix.py b/fix.py\n",
				}),
			)
			.concat("")
			.join("\n"),
	);
	const metrics = {
		model_rounds_total: 0,
		primary_model_rounds: 0,
		support_model_rounds: 0,
		failed_model_attempts: 0,
		tool_calls_total: 0,
		tool_call_counts: {
			requested: 0,
			completed: 0,
			succeeded: 0,
			failed: 0,
			rejected: 0,
			incomplete: 0,
		},
		tool_calls_by_tool: {},
		tool_calls_per_model_round: null,
		tokens: {
			input: 0,
			output: 0,
			reasoning: 0,
			cache_read: 0,
			cache_write: 0,
			total_tokens: 0,
			cost_total: null,
			cache_metrics_available: false,
			cache_hit_rate: null,
		},
		wall_seconds: 0,
		terminated_by: null,
	};
	for (const c of cases) {
		const caseDir = path.join(dir, "cases", c.id.replace(/\//g, "__"));
		const attemptDir = path.join(caseDir, "attempts", "1");
		fs.mkdirSync(attemptDir, { recursive: true });
		fs.writeFileSync(
			path.join(caseDir, "case.json"),
			JSON.stringify({
				schema_version: 1,
				instance_id: c.id,
				attempts: [
					{
						attempt: 1,
						execution_status: "completed",
						terminated_by: null,
						evaluation_run_id: `bench-20260819-000000-attr--${c.id.replace(/\//g, "__")}--a1`,
						verdict: "resolved",
						started_at: "2026-08-19T00:00:00Z",
						ended_at: "2026-08-19T00:01:00Z",
						metrics,
					},
				],
				final_verdict: "resolved",
			}),
		);
		fs.writeFileSync(
			path.join(attemptDir, "usage.jsonl"),
			c.usage.map((row) => `${JSON.stringify(row)}\n`).join(""),
		);
		fs.writeFileSync(
			path.join(attemptDir, "tool-calls.jsonl"),
			c.tools.map((row) => `${JSON.stringify(row)}\n`).join(""),
		);
	}
}

function usageRow(
	role: string,
	provider: string,
	model: string,
	extra: Record<string, unknown> = {},
): any {
	return {
		schema_version: 1,
		at: "2026-01-01T00:00:00Z",
		attempt: 1,
		role,
		provider,
		model,
		handoff_id: null,
		goal_id: null,
		lane: null,
		usage: {
			input: 90,
			output: 10,
			reasoning: 0,
			cache_read: 0,
			cache_write: 0,
			total_tokens: 100,
			cost: null,
		},
		...extra,
	};
}

function toolRow(
	callId: string,
	provider: string,
	model: string,
	status: "succeeded" | "failed" | "rejected" | null,
	extra: Record<string, unknown> = {},
): any {
	return {
		schema_version: 1,
		kind: status === null ? "requested" : "result",
		call_id: callId,
		tool: "bash",
		status,
		at: "2026-01-01T00:00:00Z",
		run_id: "run-cnt",
		role: "coder",
		depth: 0,
		handoff_id: null,
		goal_id: "g1",
		lane: "code",
		provider,
		model,
		...extra,
	};
}

/** A requested+result row pair for one call. */
function callPair(
	callId: string,
	provider: string,
	model: string,
	status: "succeeded" | "failed" | "rejected",
	extra: Record<string, unknown> = {},
): any[] {
	return [
		toolRow(callId, provider, model, null, extra),
		toolRow(callId, provider, model, status, extra),
	];
}

describe("CNT: report by-model tool counts use the recorded fields", () => {
	test("CNT-1 a multi-model role gets exact per-model tool counts (inference cannot answer)", async () => {
		const mod = await bench();
		const dir = makeTmpDir();
		handBuiltOutDir(dir, [
			{
				id: "demo/a",
				usage: [
					usageRow("coder", "p", "A", { lane: "code", goal_id: "g1" }),
					usageRow("coder", "p", "A", { lane: "code", goal_id: "g1" }),
					usageRow("coder", "p", "B", { lane: "code", goal_id: "g1" }),
					usageRow("planner", "p", "P"),
				],
				tools: [
					...callPair("a1", "p", "A", "succeeded"),
					...callPair("b1", "p", "B", "failed"),
					...callPair("b2", "p", "B", "rejected"),
					toolRow("b3", "p", "B", null), // incomplete
					...callPair("p1", "p", "P", "succeeded", { role: "planner", goal_id: null, lane: null }),
				],
			},
		]);
		const report = mod.buildBenchmarkReport(dir);
		// By-model tool counts equal the recorded provider/model groups.
		expect(report.breakdowns.by_model["p/A"].tool_calls).toBe(1);
		expect(report.breakdowns.by_model["p/B"].tool_calls).toBe(3);
		expect(report.breakdowns.by_model["p/P"].tool_calls).toBe(1);
		expect(report.breakdowns.by_model["p/A"].model_rounds).toBe(2);
		expect(report.breakdowns.by_model["p/B"].model_rounds).toBe(1);
		expect(report.breakdowns.by_model["p/P"].model_rounds).toBe(1);
		// Role/lane breakdowns are unchanged by the attribution fix.
		expect(report.breakdowns.by_role.coder.tool_calls).toBe(4);
		expect(report.breakdowns.by_role.planner.tool_calls).toBe(1);
		expect(report.breakdowns.by_lane.code.tool_calls).toBe(4);
		// Conservation: no calls silently vanish from the model dimension.
		const modelTotal = Object.values(report.breakdowns.by_model).reduce(
			(sum: number, entry: any) => sum + entry.tool_calls,
			0,
		);
		const roleTotal = Object.values(report.breakdowns.by_role).reduce(
			(sum: number, entry: any) => sum + entry.tool_calls,
			0,
		);
		expect(modelTotal).toBe(roleTotal);
		expect(modelTotal).toBe(5);
	});

	test("CNT-2 recorded attribution wins when usage-side inference would guess wrong", async () => {
		const mod = await bench();
		const dir = makeTmpDir();
		// The coder role shows exactly ONE model in the usage ledger (a
		// budget stop can flush a tool row while its usage row is lost), but
		// the tool rows record a different model. Any role→model inference
		// would hand both calls to p/A; the recorded fields say p/B.
		handBuiltOutDir(dir, [
			{
				id: "demo/c",
				usage: [usageRow("coder", "p", "A", { lane: "code", goal_id: "g1" })],
				tools: [
					...callPair("x1", "p", "B", "succeeded"),
					...callPair("x2", "p", "B", "failed"),
				],
			},
		]);
		const report = mod.buildBenchmarkReport(dir);
		expect(report.breakdowns.by_model["p/B"].tool_calls).toBe(2);
		expect(report.breakdowns.by_model["p/B"].model_rounds).toBe(0);
		expect(report.breakdowns.by_model["p/A"].tool_calls).toBe(0);
		expect(report.breakdowns.by_model["p/A"].model_rounds).toBe(1);
	});

	test("CNT-3 zero-tool models and zero-round tool emitters remain visible in every breakdown", async () => {
		const mod = await bench();
		const dir = makeTmpDir();
		handBuiltOutDir(dir, [
			{
				id: "demo/complete-dimensions",
				usage: [usageRow("planner", "p", "P")],
				tools: [
					...callPair("ghost-1", "p", "G", "succeeded", {
						role: "ghost",
						goal_id: "g-ghost",
						lane: "verify",
					}),
				],
			},
		]);
		const report = mod.buildBenchmarkReport(dir);
		expect(report.breakdowns.by_model["p/P"]).toEqual({
			model_rounds: 1,
			tool_calls: 0,
			total_tokens: 100,
		});
		expect(report.breakdowns.by_model["p/G"].tool_calls).toBe(1);
		expect(report.breakdowns.by_model["p/G"].model_rounds).toBe(0);
		expect(report.breakdowns.by_role.ghost.tool_calls).toBe(1);
		expect(report.breakdowns.by_role.ghost.model_rounds).toBe(0);
		expect(report.breakdowns.by_lane.verify.tool_calls).toBe(1);
		expect(report.breakdowns.by_lane.verify.model_rounds).toBe(0);
	});

	test("CNT-4 fixture run: report by-model tool counts reproduce the recorded ledger grouping", async () => {
		const mod = await bench();
		const outDir = makeTmpDir();
		const fixture = mod.loadFixtureDriver(FIXTURE_DRIVER_DIR);
		await mod.runBenchmark({
			dataset: SNAPSHOT,
			instances: ["demo/demo-1001", "demo/demo-1002"],
			outDir,
			driver: fixture.driver,
			evaluator: fixture.evaluator,
			clock: fixture.clock,
			codeflowCommit: "0".repeat(40),
		});
		const report = mod.buildBenchmarkReport(outDir);

		// Recompute by-model tool counts straight from the recorded rows.
		const expected: Record<string, number> = {};
		const casesRoot = path.join(outDir, "cases");
		for (const entry of fs.readdirSync(casesRoot, { withFileTypes: true })) {
			const file = path.join(casesRoot, entry.name, "attempts", "1", "tool-calls.jsonl");
			for (const row of readJsonlFile(file)) {
				if (row.kind !== "requested") continue;
				expect(typeof row.provider).toBe("string");
				expect(row.provider.length).toBeGreaterThan(0);
				expect(typeof row.model).toBe("string");
				expect(row.model.length).toBeGreaterThan(0);
				const key = `${row.provider}/${row.model}`;
				expected[key] = (expected[key] ?? 0) + 1;
			}
		}
		// Never vacuous: the fixture run has real attributed calls.
		expect(expected["fixture/fixture-coder"]).toBe(7);
		const actual: Record<string, number> = {};
		for (const [model, totals] of Object.entries<any>(report.breakdowns.by_model)) {
			// Usage-only models are intentionally present with zero calls; this
			// assertion compares the recorded tool grouping itself.
			if (totals.tool_calls > 0) actual[model] = totals.tool_calls;
		}
		expect(actual).toEqual(expected);
	});
});

// --------------------------------------------------------------------------
// PRIV — deep scan of serialized artifacts
// --------------------------------------------------------------------------

describe("PRIV: serialized ledger and report artifacts stay payload-free", () => {
	test("PRIV-1 nested cases/<instance> ledgers and report.json carry no payload keys at any depth", async () => {
		const mod = await bench();
		const outDir = await runWithDriver(attributedRoundsDriver());
		const report = mod.buildBenchmarkReport(outDir);

		// Every per-attempt tool ledger row, deep-scanned.
		const casesRoot = path.join(outDir, "cases");
		let scannedRows = 0;
		for (const entry of fs.readdirSync(casesRoot, { withFileTypes: true })) {
			const file = path.join(casesRoot, entry.name, "attempts", "1", "tool-calls.jsonl");
			for (const row of readJsonlFile(file)) {
				scannedRows++;
				expect(forbiddenKeysIn(row)).toEqual([]);
			}
		}
		expect(scannedRows).toBeGreaterThanOrEqual(10); // the scenario's rows exist

		// The report object tree, deep-scanned (identifier-valued map keys
		// like lane "code" are exempt; their values are scanned).
		expect(forbiddenReportKeysIn(report)).toEqual([]);
		// Serialized report.json is the artifact that leaves the machine.
		const serialized = JSON.parse(fs.readFileSync(path.join(outDir, "report.json"), "utf8"));
		expect(forbiddenReportKeysIn(serialized)).toEqual([]);
	});

	test("PRIV-2 attribution is typed: provider/model cannot smuggle payloads", async () => {
		const mod = await bench();
		const file = path.join(makeTmpDir(), "tool-calls.jsonl");
		expect(() =>
			mod.appendToolCallRecord(file, attributedRow("c1", "result", { provider: 12345 })),
		).toThrow();
		expect(fs.existsSync(file)).toBe(false);
	});
});
