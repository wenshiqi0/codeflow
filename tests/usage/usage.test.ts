import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunPaths } from "../../runtime/lib/paths";
import {
	appendUsageRecord,
	buildUsageReport,
	readUsageRecords,
	renderUsageSummary,
	usageRecordFromMessage,
	writeUsageSummary,
} from "../../runtime/lib/usage";

let dir: string;
let paths: RunPaths;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-usage-"));
	paths = new RunPaths(path.join(dir, ".codeflow", "runs", "code"), "run-usage-test");
	for (const key of [
		"CODEFLOW_RUN_ID",
		"CODEFLOW_RUNS_DIR",
		"CODEFLOW_AGENT_ROLE",
		"CODEFLOW_AGENT_DEPTH",
		"CODEFLOW_HANDOFF_ID",
		"CODEFLOW_GOAL_ID",
		"CODEFLOW_LANE",
	]) {
		savedEnv[key] = process.env[key];
	}
	process.env.CODEFLOW_RUN_ID = paths.runId;
	process.env.CODEFLOW_RUNS_DIR = paths.code;
	process.env.CODEFLOW_AGENT_ROLE = "coder";
	process.env.CODEFLOW_AGENT_DEPTH = "1";
	process.env.CODEFLOW_HANDOFF_ID = "h00001-coder";
	process.env.CODEFLOW_GOAL_ID = "graph-bench";
	process.env.CODEFLOW_LANE = "code";
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

function assistantMessage(overrides: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		provider: "zhipuai-coding-plan",
		model: "glm-5.3",
		responseModel: "glm-5.3",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 30,
			cacheWrite: 5,
			reasoning: 10,
			totalTokens: 155,
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25, total: 3.75 },
		},
		timestamp: Date.now(),
		...overrides,
	};
}

describe("usage records", () => {
	test("normalizes one assistant model round with Codeflow attribution", () => {
		const record = usageRecordFromMessage(assistantMessage(), 3);
		expect(record).toMatchObject({
			schema_version: 1,
			run_id: "run-usage-test",
			role: "coder",
			depth: 1,
			handoff_id: "h00001-coder",
			goal_id: "graph-bench",
			lane: "code",
			turn: 3,
			provider: "zhipuai-coding-plan",
			model: "glm-5.3",
			response_model: "glm-5.3",
			usage: {
				input: 100,
				output: 20,
				cache_read: 30,
				cache_write: 5,
				reasoning: 10,
				total_tokens: 155,
				cost: { input: 1, output: 2, cache_read: 0.5, cache_write: 0.25, total: 3.75 },
			},
		});
		expect(record.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	test("ignores messages without assistant usage", () => {
		expect(usageRecordFromMessage({ role: "user" }, 1)).toBeNull();
		expect(usageRecordFromMessage({ role: "assistant", usage: undefined }, 1)).toBeNull();
	});

	test("persists JSONL records and reports per-model plus run totals", () => {
		const first = usageRecordFromMessage(assistantMessage(), 1)!;
		const second = usageRecordFromMessage(
			assistantMessage({
				provider: "deepseek",
				model: "deepseek-v4-flash",
				responseModel: "deepseek-v4-flash",
				usage: {
					input: 10,
					output: 4,
					cacheRead: 0,
					cacheWrite: 0,
					reasoning: 2,
					totalTokens: 14,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
			1,
		)!;
		appendUsageRecord(paths, first);
		appendUsageRecord(paths, second);

		const records = readUsageRecords(paths);
		expect(records).toHaveLength(2);
		const report = buildUsageReport(paths.runId, records);
		expect(report.models).toEqual([
			expect.objectContaining({
				model: "deepseek/deepseek-v4-flash",
				calls: 1,
				input: 10,
				output: 4,
				cache_read: 0,
				cache_write: 0,
				reasoning: 2,
				total_tokens: 14,
				cost_total: 0,
			}),
			expect.objectContaining({
				model: "zhipuai-coding-plan/glm-5.3",
				calls: 1,
				input: 100,
				output: 20,
				cache_read: 30,
				cache_write: 5,
				reasoning: 10,
				total_tokens: 155,
				cost_total: 3.75,
			}),
		]);
		expect(report.total).toEqual({
			calls: 2,
			input: 110,
			output: 24,
			cache_read: 30,
			cache_write: 5,
			reasoning: 12,
			total_tokens: 169,
			cost_input: 1,
			cost_output: 2,
			cost_cache_read: 0.5,
			cost_cache_write: 0.25,
			cost_total: 3.75,
		});

		const summaryPath = writeUsageSummary(paths);
		expect(fs.existsSync(summaryPath)).toBe(true);
		expect(renderUsageSummary(report)).toContain("zhipuai-coding-plan/glm-5.3 calls=1");
		expect(renderUsageSummary(report)).toContain(
			"total calls=2 in=110 out=24 cache_r=30 cache_w=5 reasoning=12 tokens=169 cost=3.75",
		);
	});
});

describe("usage extension", () => {
	test("records assistant turns to the shared run ledger", async () => {
		const mod = await import("../../runtime/extensions/usage-ledger/index.ts");
		const handlers: Record<string, (event: unknown) => unknown> = {};
		mod.default({
			on: (kind: string, handler: (event: unknown) => unknown) => {
				handlers[kind] = handler;
			},
		});

		await handlers.turn_start({ type: "turn_start", turnIndex: 4, timestamp: Date.now() });
		await handlers.message_end({ type: "message_end", message: assistantMessage() });
		await handlers.message_end({ type: "message_end", message: { role: "toolResult" } });

		const records = readUsageRecords(paths);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ role: "coder", turn: 5 });
	});

	test("root and delegated role launchers load the ledger and final report", () => {
		const cliRun = fs.readFileSync(path.resolve(import.meta.dir, "../../runtime/cli/run.ts"), "utf8");
		const taskLauncher = fs.readFileSync(
			path.resolve(import.meta.dir, "../../runtime/extensions/codeflow-task/role-launcher.ts"),
			"utf8",
		);

		expect(cliRun).toContain('extensions", "usage-ledger"');
		expect(cliRun).toContain("writeUsageSummary(paths)");
		expect(cliRun).toContain("renderUsageSummary");
		expect(taskLauncher).toContain('extensions", "usage-ledger"');
	});
});
