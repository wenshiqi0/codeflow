import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../../runtime/extensions/codeflow-context/index";
import { resolveRole } from "../../runtime/lib/roles";

const repo = path.resolve(import.meta.dir, "../..");

interface ContextResult {
	systemPrompt: string;
	message: {
		content: string;
		details: {
			role: string;
			level: string;
			mode: "full" | "delta" | "fallback";
			sources: Array<{ kind: string; ref: string; hash: string; action?: string }>;
			facts: { fromCursor: number; toCursor: number };
			generatedAt: string;
			fallbackReason?: string;
		};
	};
}

interface SessionEntryLike {
	type: string;
	customType: string;
	content: string;
	details: ContextResult["message"]["details"];
}

describe("codeflow context extension", () => {
	test("keeps the canonical role prompt and injects only allowed context", () => {
		const handlers = new Map<string, (event: unknown) => unknown>();
		extension({
			on: (type: string, handler: (event: unknown) => unknown) => {
				handlers.set(type, handler);
			},
			appendEntry: () => undefined,
		} as never);
		const handler = handlers.get("before_agent_start");
		expect(handler).toBeFunction();

		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-context-event-"));
		try {
			const systemPrompt = resolveRole(
				path.join(repo, "runtime/roles.json"),
				"planner",
			)?.systemPrompt ?? "";
			const result = handler({
				systemPrompt,
				systemPromptOptions: { cwd },
			}) as {
				systemPrompt: string;
				message: {
					content: string;
					details: { sources: Array<{ kind: string; ref: string }>; generatedAt: string };
				};
			};

			expect(result.systemPrompt).toContain("# Planner Capability");
			expect(result.systemPrompt).toContain("five read-only information calls or five minutes");
			expect(result.systemPrompt).not.toContain("codeflow:import");
			expect(result.message.content).not.toContain("<context_imports>");
			expect(result.message.details.sources.some((source) => source.kind === "context_import")).toBeFalse();
			expect(result.message.content).not.toContain("generated_at");
			expect(result.message.details.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
			expect(result.message.content).not.toContain("# codeflow");
			expect(result.message.content).not.toContain("scripts/doctor.sh");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("keeps the Pi agent directory available to role tools", () => {
		const saved = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = "/private/codeflow-runtime";
		const handlers = new Map<string, (event: unknown) => unknown>();
		extension({
			on: (type: string, handler: (event: unknown) => unknown) => {
				handlers.set(type, handler);
			},
			appendEntry: () => undefined,
		} as never);
		try {
			handlers.get("before_agent_start")?.({
				systemPrompt: "",
				systemPromptOptions: { cwd: process.cwd() },
			});
			expect(process.env.PI_CODING_AGENT_DIR).toBe("/private/codeflow-runtime");
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
		}
	});

	test("continues a session with static-source deltas and raw fact deltas", () => {
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
		extension({
			on: (type: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
				handlers.set(type, handler);
			},
			appendEntry: () => undefined,
		} as never);
		const handler = handlers.get("before_agent_start");
		expect(handler).toBeFunction();

		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-context-delta-"));
		const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-context-runs-"));
		const runId = `run-${Date.now()}`;
		const runDir = path.join(runsDir, runId);
		const savedRole = process.env.CODEFLOW_AGENT_ROLE;
		const savedRunId = process.env.CODEFLOW_RUN_ID;
		const savedRunsDir = process.env.CODEFLOW_RUNS_DIR;
		process.env.CODEFLOW_AGENT_ROLE = "coder";
		process.env.CODEFLOW_RUN_ID = runId;
		process.env.CODEFLOW_RUNS_DIR = runsDir;

		try {
			fs.mkdirSync(runDir, { recursive: true });
			const ledger = path.join(runDir, "facts.jsonl");
			fs.writeFileSync(
				ledger,
				JSON.stringify({
					id: "f1",
					kind: "fact",
					role: "tester",
					handoff_id: "h1",
					claim: "first fact",
					value: "one",
				}) + "\n",
				"utf-8",
			);

			let entries: SessionEntryLike[] = [];
			const invoke = () => {
				const sessionManager = {
					buildContextEntries: () => entries.slice(),
				};
				return handler(
					{
						systemPrompt: resolveRole(
							path.join(repo, "runtime/roles.json"),
							"coder",
						)?.systemPrompt ?? "",
						systemPromptOptions: { cwd },
					},
					{ sessionManager },
				) as ContextResult;
			};

			const first = invoke();
			expect(first.message.details.mode).toBe("full");
			expect(first.message.details.facts).toEqual({ fromCursor: 0, toCursor: 1 });
			expect(first.message.content).toContain("<shared_rules>");
			expect(first.message.content).toContain("f1: first fact — one [tester]");

			const firstEntry: SessionEntryLike = {
				type: "custom_message",
				customType: "codeflow:context",
				content: first.message.content,
				details: first.message.details,
			};
			entries = [firstEntry];

			const second = invoke();
			expect(second.message.details.mode).toBe("delta");
			expect(second.message.details.facts).toEqual({ fromCursor: 1, toCursor: 1 });
			expect(second.message.content).not.toContain("<shared_rules>");
			expect(second.message.content).toContain("No new shared facts were recorded");

			const secondEntry: SessionEntryLike = {
				type: "custom_message",
				customType: "codeflow:context",
				content: second.message.content,
				details: second.message.details,
			};
			entries = [firstEntry, secondEntry];
			fs.appendFileSync(
				ledger,
				JSON.stringify({
					id: "f2",
					kind: "supersede",
					role: "coder",
					handoff_id: "h2",
					claim: "second fact",
					value: "two",
					supersedes: "f1",
					reason: "corrected",
				}) + "\n",
				"utf-8",
			);

			const third = invoke();
			expect(third.message.details.mode).toBe("delta");
			expect(third.message.details.facts).toEqual({ fromCursor: 1, toCursor: 2 });
			expect(third.message.content).toContain("<shared_facts_delta>");
			expect(third.message.content).toContain("f2: second fact — two [coder]; supersedes f1 (corrected)");
			expect(third.message.content).not.toContain("f1: first fact");
			expect(third.message.content).not.toContain("<shared_rules>");
			expect(third.message.content).not.toContain("generated_at");
			expect(third.message.content).not.toContain("fallbackReason");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
			fs.rmSync(runsDir, { recursive: true, force: true });
			if (savedRole === undefined) delete process.env.CODEFLOW_AGENT_ROLE;
			else process.env.CODEFLOW_AGENT_ROLE = savedRole;
			if (savedRunId === undefined) delete process.env.CODEFLOW_RUN_ID;
			else process.env.CODEFLOW_RUN_ID = savedRunId;
			if (savedRunsDir === undefined) delete process.env.CODEFLOW_RUNS_DIR;
			else process.env.CODEFLOW_RUNS_DIR = savedRunsDir;
		}
	});

	test("invalid previous cursor metadata falls back to a full context", () => {
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
		extension({
			on: (type: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
				handlers.set(type, handler);
			},
			appendEntry: () => undefined,
		} as never);
		const handler = handlers.get("before_agent_start");
		expect(handler).toBeFunction();

		const savedRole = process.env.CODEFLOW_AGENT_ROLE;
		const savedRunId = process.env.CODEFLOW_RUN_ID;
		process.env.CODEFLOW_AGENT_ROLE = "coder";
		delete process.env.CODEFLOW_RUN_ID;
		try {
			const result = handler(
				{ systemPrompt: "", systemPromptOptions: { cwd: process.cwd() } },
				{
					sessionManager: {
						buildContextEntries: () => [
							{
								type: "custom_message",
								customType: "codeflow:context",
								details: {
									role: "coder",
									level: "shared",
									sources: [],
									facts: {},
								},
							},
						],
					},
				},
			) as ContextResult;

			expect(result.message.details.mode).toBe("fallback");
			expect(result.message.details.fallbackReason).toBe("previous_facts_cursor_invalid");
			expect(result.message.content).toContain('mode="full"');
			expect(result.message.content).toContain("<shared_rules>");
			expect(result.message.content).not.toContain("fallbackReason");
		} finally {
			if (savedRole === undefined) delete process.env.CODEFLOW_AGENT_ROLE;
			else process.env.CODEFLOW_AGENT_ROLE = savedRole;
			if (savedRunId === undefined) delete process.env.CODEFLOW_RUN_ID;
			else process.env.CODEFLOW_RUN_ID = savedRunId;
		}
	});

	test("CODEFLOW_CONTEXT_DELTA=off disables continuation injection", () => {
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
		extension({
			on: (type: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
				handlers.set(type, handler);
			},
			appendEntry: () => undefined,
		} as never);
		const handler = handlers.get("before_agent_start");
		expect(handler).toBeFunction();

		const savedRole = process.env.CODEFLOW_AGENT_ROLE;
		const savedRunId = process.env.CODEFLOW_RUN_ID;
		const savedDelta = process.env.CODEFLOW_CONTEXT_DELTA;
		process.env.CODEFLOW_AGENT_ROLE = "supervisor";
		process.env.CODEFLOW_CONTEXT_DELTA = "off";
		delete process.env.CODEFLOW_RUN_ID;
		try {
			const result = handler(
				{ systemPrompt: "", systemPromptOptions: { cwd: process.cwd() } },
				{
					sessionManager: {
						buildContextEntries: () => [
							{
								type: "custom_message",
								customType: "codeflow:context",
								details: {
									role: "supervisor",
									level: "none",
									sources: [],
									facts: { fromCursor: 0, toCursor: 0 },
								},
							},
						],
					},
				},
			) as ContextResult;

			expect(result.message.details.mode).toBe("fallback");
			expect(result.message.details.fallbackReason).toBe("context_delta_disabled");
			expect(result.message.content).toContain('mode="full"');
		} finally {
			if (savedRole === undefined) delete process.env.CODEFLOW_AGENT_ROLE;
			else process.env.CODEFLOW_AGENT_ROLE = savedRole;
			if (savedRunId === undefined) delete process.env.CODEFLOW_RUN_ID;
			else process.env.CODEFLOW_RUN_ID = savedRunId;
			if (savedDelta === undefined) delete process.env.CODEFLOW_CONTEXT_DELTA;
			else process.env.CODEFLOW_CONTEXT_DELTA = savedDelta;
		}
	});
});
