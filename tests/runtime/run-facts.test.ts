import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import codeflowContext from "../../runtime/extensions/codeflow-context";
import { readRunFactsRecords, summarizePrefixCache } from "../../runtime/lib/observability/run-facts";
import { RunPaths } from "../../runtime/lib/paths";

const dirs: string[] = [];
const saved = {
	runId: process.env.CODEFLOW_RUN_ID,
	runsDir: process.env.CODEFLOW_RUNS_DIR,
	handoffId: process.env.CODEFLOW_HANDOFF_ID,
	goalId: process.env.CODEFLOW_GOAL_ID,
};
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of Object.entries({
		CODEFLOW_RUN_ID: saved.runId,
		CODEFLOW_RUNS_DIR: saved.runsDir,
		CODEFLOW_HANDOFF_ID: saved.handoffId,
		CODEFLOW_GOAL_ID: saved.goalId,
	})) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function harness(paths: RunPaths) {
	process.env.CODEFLOW_RUN_ID = paths.runId;
	process.env.CODEFLOW_RUNS_DIR = paths.code;
	process.env.CODEFLOW_HANDOFF_ID = "h_current";
	process.env.CODEFLOW_GOAL_ID = paths.runId;
	const handlers = new Map<string, (...args: any[]) => any>();
	codeflowContext({ on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); } } as never);
	return handlers;
}

describe("execution-local run facts", () => {
	test("context hook appends current facts and exact prefix transition counters", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-facts-"));
		dirs.push(root);
		const paths = new RunPaths(path.join(root, "runs"), "task-facts");
		const handlers = harness(paths);
		const context = handlers.get("context")!;
		const messageEnd = handlers.get("message_end")!;
		let usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined = {
			tokens: 250,
			contextWindow: 1000,
			percent: 25,
		};
		const ctx = { getContextUsage: () => usage };
		const firstMessage = { role: "user", content: "work", timestamp: 1 };
		const first = context({ messages: [firstMessage] }, ctx);
		const firstFacts = first.messages.at(-1);
		expect(firstFacts.content).toContain('"execution_rounds_elapsed":0');
		expect(firstFacts.content).toContain('"basis":"pi_estimate"');
		expect(firstFacts.content).toContain('"value":0.25');
		expect(firstFacts.content).not.toMatch(/\b(?:should|prefer|consider|split)\b/i);

		messageEnd({ message: { role: "assistant" } });
		const assistant = { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 };
		context({ messages: [firstMessage, assistant] }, ctx);
		usage = undefined;
		const third = context({ messages: [{ ...firstMessage, content: "changed" }, assistant] }, ctx);
		expect(third.messages.at(-1).content).toContain('"execution_rounds_elapsed":1');
		expect(third.messages.at(-1).content).toContain('"basis":"unknown"');

		const records = readRunFactsRecords(paths.runFactsLedger);
		expect(records.map((record) => [record.prefix_transition_count, record.prefix_invalidation_count])).toEqual([
			[0, 0],
			[1, 0],
			[1, 1],
		]);
		expect(summarizePrefixCache(records)).toEqual({
			prefix_transition_count: 2,
			prefix_invalidation_count: 1,
			prefix_invalidation_rate: 0.5,
			metrics_available: true,
		});
	});

	test("a fresh execution restarts elapsed rounds and transition state", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-facts-"));
		dirs.push(root);
		const paths = new RunPaths(path.join(root, "runs"), "task-facts");
		const first = harness(paths);
		first.get("message_end")!({ message: { role: "assistant" } });
		first.get("context")!({ messages: [{ role: "user", content: "one" }] }, { getContextUsage: () => undefined });
		const restarted = harness(paths);
		const result = restarted.get("context")!({ messages: [{ role: "user", content: "one" }] }, { getContextUsage: () => undefined });
		expect(result.messages.at(-1).content).toContain('"execution_rounds_elapsed":0');
		const records = readRunFactsRecords(paths.runFactsLedger);
		expect(records.map((record) => record.prefix_transition_count)).toEqual([0, 0]);
		expect(Object.keys(records[0]).sort()).toEqual(Object.keys(records[1]).sort());
	});
});
