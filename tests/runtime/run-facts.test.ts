import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CONTEXT_BUDGET_INTERRUPTED_SUMMARY,
	AGENT_CONTEXT_STOP_UTILIZATION,
	default as codeflowContext,
} from "../../runtime/extensions/codeflow-context";
import { commitmentHistory, loadReceiptChain, submitReceipt } from "../../runtime/lib/commitment";
import { loadWorkerReport } from "../../runtime/lib/executions";
import { scan } from "../../runtime/lib/wait";
import { readRunFactsRecords, summarizePrefixCache } from "../../runtime/lib/observability/run-facts";
import { RunPaths } from "../../runtime/lib/paths";
import { createTask } from "../../runtime/lib/tasks";
import { claimTestWork } from "./helpers";

const dirs: string[] = [];
const saved = {
	runId: process.env.CODEFLOW_RUN_ID,
	runsDir: process.env.CODEFLOW_RUNS_DIR,
	commitmentId: process.env.CODEFLOW_COMMITMENT_ID,
	goalId: process.env.CODEFLOW_GOAL_ID,
	executionId: process.env.CODEFLOW_EXECUTION_ID,
	processKind: process.env.CODEFLOW_PROCESS_KIND,
};
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of Object.entries({
		CODEFLOW_RUN_ID: saved.runId,
		CODEFLOW_RUNS_DIR: saved.runsDir,
		CODEFLOW_COMMITMENT_ID: saved.commitmentId,
		CODEFLOW_GOAL_ID: saved.goalId,
		CODEFLOW_EXECUTION_ID: saved.executionId,
		CODEFLOW_PROCESS_KIND: saved.processKind,
	})) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function harness(paths: RunPaths, kind: "root" | "worker" = "root") {
	createTask(paths, "observe prompt shape");
	process.env.CODEFLOW_RUN_ID = paths.runId;
	process.env.CODEFLOW_RUNS_DIR = paths.code;
	delete process.env.CODEFLOW_COMMITMENT_ID;
	process.env.CODEFLOW_GOAL_ID = paths.runId;
	process.env.CODEFLOW_EXECUTION_ID = "exec-facts";
	process.env.CODEFLOW_PROCESS_KIND = kind;
	const handlers = new Map<string, (...args: any[]) => any>();
	let toolDescription = "Read files";
	codeflowContext({
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		getActiveTools: () => ["read"],
		getAllTools: () => [{
			name: "read",
			description: toolDescription,
			parameters: { type: "object", properties: { path: { type: "string" } } },
			promptGuidelines: [],
			sourceInfo: { source: "builtin" },
		}],
	} as never);
	const bootstrap = handlers.get("before_agent_start")!({
		prompt: "work",
		systemPrompt: "system-a",
		systemPromptOptions: { cwd: path.dirname(paths.code) },
	});
	return {
		handlers,
		bootstrapMessage: bootstrap.message,
		changeToolDescription(value: string) { toolDescription = value; },
	};
}

describe("execution-local run facts", () => {
	test("records the complete prompt shape and only injects facts at utilization thresholds", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-facts-"));
		dirs.push(root);
		const paths = new RunPaths(path.join(root, "runs"), "task-facts");
		const runtime = harness(paths);
		const context = runtime.handlers.get("context")!;
		const messageEnd = runtime.handlers.get("message_end")!;
		let systemPrompt = "system-a";
		let usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined = {
			tokens: 250,
			contextWindow: 1000,
			percent: 25,
		};
		const ctx = { getContextUsage: () => usage, getSystemPrompt: () => systemPrompt };
		const firstMessage = { role: "user", content: "work", timestamp: 1 };
		const baseMessages = [firstMessage, runtime.bootstrapMessage];
		const first = context({ messages: baseMessages }, ctx);
		expect(first.messages).toEqual(baseMessages);

		messageEnd({ message: { role: "assistant" } });
		const assistant = { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 };
		usage = { tokens: 550, contextWindow: 1000, percent: 55 };
		const second = context({ messages: [...baseMessages, assistant] }, ctx);
		expect(second.messages.at(-1).content).toContain('"execution_rounds_elapsed":1');
		expect(second.messages.at(-1).content).toContain('"value":0.55');

		systemPrompt = "system-b";
		usage = { tokens: 600, contextWindow: 1000, percent: 60 };
		const third = context({ messages: [...baseMessages, assistant] }, ctx);
		expect(third.messages).toEqual([...baseMessages, assistant]);

		runtime.changeToolDescription("Read bounded file ranges");
		usage = { tokens: 710, contextWindow: 1000, percent: 71 };
		const changedMessage = { ...firstMessage, content: "changed" };
		const fourth = context({ messages: [changedMessage, runtime.bootstrapMessage, assistant] }, ctx);
		expect(fourth.messages.at(-1).content).toContain('"value":0.71');

		const records = readRunFactsRecords(paths.runFactsLedger);
		expect(records.map((record) => [record.prefix_transition_count, record.prefix_invalidation_count])).toEqual([
			[0, 0],
			[1, 0],
			[1, 1],
			[1, 1],
		]);
		expect(records.map((record) => [
			record.system_prompt_changed,
			record.tool_schema_changed,
			record.worker_context_changed,
			record.message_prefix_invalidated,
		])).toEqual([
			[0, 0, 0, 0],
			[0, 0, 0, 0],
			[1, 0, 0, 1],
			[0, 1, 0, 1],
		]);
		expect(records[0].prompt_shape.system_prompt.chars).toBe(8);
		expect(records[0].prompt_shape.tool_schema.count).toBe(1);
		expect(Array.isArray(records[0].prompt_shape.worker_context.sections)).toBe(true);
		expect(records.every((record) => Number.isSafeInteger(record.prompt_shape.message_prefix.chars))).toBe(true);
		expect(summarizePrefixCache(records)).toMatchObject({
			prefix_transition_count: 3,
			prefix_invalidation_count: 2,
			prefix_invalidation_rate: 2 / 3,
			system_prompt_change_count: 1,
			tool_schema_change_count: 1,
			worker_context_change_count: 0,
			message_prefix_invalidation_count: 2,
			prompt_shape_metrics_available: true,
			max_context_utilization: 0.71,
			metrics_available: true,
		});
	});

	test("a fresh execution restarts elapsed rounds, thresholds, and prompt shape comparison", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-facts-"));
		dirs.push(root);
		const paths = new RunPaths(path.join(root, "runs"), "task-facts");
		const first = harness(paths);
		first.handlers.get("message_end")!({ message: { role: "assistant" } });
		first.handlers.get("context")!({ messages: [{ role: "user", content: "one" }, first.bootstrapMessage] }, {
			getContextUsage: () => undefined,
			getSystemPrompt: () => "system",
		});
		const restarted = harness(paths);
		const result = restarted.handlers.get("context")!({ messages: [{ role: "user", content: "one" }, restarted.bootstrapMessage] }, {
			getContextUsage: () => undefined,
			getSystemPrompt: () => "system",
		});
		expect(result.messages).toHaveLength(2);
		const records = readRunFactsRecords(paths.runFactsLedger);
		expect(records.map((record) => record.prefix_transition_count)).toEqual([0, 0]);
		expect(records.map((record) => record.schema_version)).toEqual([3, 3]);
		expect(Object.keys(records[0]).sort()).toEqual(Object.keys(records[1]).sort());
	});

	test("Goal history appended during an execution does not rewrite its cached context prefix", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-facts-"));
		dirs.push(root);
		const paths = new RunPaths(path.join(root, "runs"), "task-facts");
		const runtime = harness(paths);
		const context = runtime.handlers.get("context")!;
		const ctx = {
			getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
			getSystemPrompt: () => "system",
		};
		const baseMessages = [{ role: "user", content: "work" }, runtime.bootstrapMessage];
		context({ messages: baseMessages }, ctx);
		const appended = claimTestWork(paths, { goalId: paths.runId, work: "later work" });
		submitReceipt(paths, { commitmentId: appended.id, status: "completed", summary: "later result" });
		expect(runtime.bootstrapMessage.content).not.toContain("later result");
		context({
			messages: [...baseMessages, { role: "assistant", content: [{ type: "text", text: "continue" }] }],
		}, ctx);
		const records = readRunFactsRecords(paths.runFactsLedger);
		expect(records.map((record) => record.worker_context_changed)).toEqual([0, 0]);
		expect(records.map((record) => record.message_prefix_invalidated)).toEqual([0, 0]);
	});

	test.each(["root", "worker"] as const)("a %s Agent interrupts at 80% without closing its own or descendant Commitments", (kind) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-facts-"));
		dirs.push(root);
		const paths = new RunPaths(path.join(root, "runs"), "task-facts");
		const runtime = harness(paths, kind);
		const commitment = claimTestWork(paths, {
			goalId: paths.runId,
			workerExecutionId: "exec-facts",
			work: "implement a bounded change",
		});
		process.env.CODEFLOW_COMMITMENT_ID = commitment.id;
		const child = claimTestWork(paths, {
			goalId: paths.runId,
			parentCommitmentId: commitment.id,
			work: "preserve child work across parent context exhaustion",
		});
		const grandchild = claimTestWork(paths, {
			goalId: paths.runId,
			parentCommitmentId: child.id,
			work: "preserve nested work across ancestor context exhaustion",
		});
		let utilization = AGENT_CONTEXT_STOP_UTILIZATION - 0.01;
		let aborts = 0;
		let shutdowns = 0;
		const ctx = {
			getContextUsage: () => ({ tokens: utilization * 1_000, contextWindow: 1_000, percent: utilization * 100 }),
			getSystemPrompt: () => "system",
			abort: () => { aborts++; },
			shutdown: () => { shutdowns++; },
		};
		const context = runtime.handlers.get("context")!;
		const messages = [{ role: "user", content: "work" }, runtime.bootstrapMessage];
		context({ messages }, ctx);
		expect(loadReceiptChain(paths, commitment.id).terminal).toBeNull();
		expect({ aborts, shutdowns }).toEqual({ aborts: 0, shutdowns: 0 });

		utilization = AGENT_CONTEXT_STOP_UTILIZATION;
		context({ messages }, ctx);
		for (const record of [commitment, child, grandchild]) {
			expect(loadReceiptChain(paths, record.id).receipts).toHaveLength(0);
			expect(loadReceiptChain(paths, record.id).terminal).toBeNull();
		}
		expect(commitmentHistory(paths).find((view) => view.commitment.id === commitment.id)?.status).toBe("open");
		const interrupted = scan(paths.events, 0, ["execution_interrupted"]).events;
		expect(interrupted).toHaveLength(1);
		expect(interrupted[0]).toMatchObject({
			reasons: ["CONTEXT_BUDGET_EXCEEDED"],
			summary: CONTEXT_BUDGET_INTERRUPTED_SUMMARY,
		});
		expect(scan(paths.events, 0, ["run_finished", "worker_reported", "receipt_submitted"]).events).toHaveLength(0);
		expect({ aborts, shutdowns }).toEqual({ aborts: 1, shutdowns: 1 });

		utilization = 0.9;
		context({ messages }, ctx);
		expect(loadReceiptChain(paths, commitment.id).receipts).toHaveLength(0);
		expect(scan(paths.events, 0, ["execution_interrupted"]).events).toHaveLength(1);
		expect({ aborts, shutdowns }).toEqual({ aborts: 1, shutdowns: 1 });
	});

	test("pre-claim context exhaustion emits one Runtime failure rather than a semantic blocker", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-facts-preclaim-"));
		dirs.push(root);
		const paths = new RunPaths(path.join(root, "runs"), "task-facts");
		const runtime = harness(paths);
		let aborts = 0;
		const ctx = {
			getContextUsage: () => ({ tokens: 800, contextWindow: 1000, percent: 80 }),
			getSystemPrompt: () => "system",
			abort: () => { aborts++; },
			shutdown() {},
		};
		const messages = [{ role: "user", content: "work" }, runtime.bootstrapMessage];
		runtime.handlers.get("context")!({ messages }, ctx);
		runtime.handlers.get("context")!({ messages }, ctx);
		expect(aborts).toBe(1);
		expect(commitmentHistory(paths)).toHaveLength(0);
		expect(loadWorkerReport(paths, "exec-facts")).toBeNull();
		const interrupted = scan(paths.events, 0, ["execution_interrupted"]).events;
		expect(interrupted).toHaveLength(1);
		expect(interrupted[0].reasons).toEqual(["CONTEXT_BUDGET_EXCEEDED"]);
		expect(scan(paths.events, 0, ["run_finished", "worker_reported", "receipt_submitted"]).events).toHaveLength(0);
	});
});
