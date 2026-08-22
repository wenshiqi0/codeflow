import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evictToolResults } from "../../runtime/extensions/codeflow-context/eviction";
import { openHandoff } from "../../runtime/lib/handoff";
import { RunPaths } from "../../runtime/lib/paths";

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-eviction-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function toolResult(id: string, text: string, timestamp = 1): any {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text }],
		timestamp,
	};
}

function options(overrides: Record<string, unknown> = {}): any {
	return {
		archiveDir: path.join(root, "evidence"),
		sessionId: "session-a",
		currentHandoffStartedAt: Number.MAX_SAFE_INTEGER,
		...overrides,
	};
}

describe("deterministic tool-result eviction", () => {
	test("selects only old, large, unprotected tool results", () => {
		const large = "x".repeat(4_097);
		const messages = Array.from({ length: 20 }, (_, index) => {
			if (index === 0) return toolResult("old-1", large);
			if (index === 1) return toolResult("old-2", large);
			if (index === 2) return toolResult("old-3", large);
			if (index === 3) return toolResult("protected", `${large}\ncode-agent handoff finish`);
			if (index === 19) return toolResult("recent", large);
			return toolResult(`small-${index}`, "small");
		});
		const next = evictToolResults(messages, options({ currentHandoffStartedAt: undefined }));
		expect(next.slice(0, 3).map((message: any) => message.content[0].text)).toHaveLength(3);
		for (const message of next.slice(0, 3)) {
			expect(message.content[0].text).toContain("[archived tool result:");
		}
		expect(next[3].content[0].text).toContain("code-agent handoff finish");
		expect(next[19].content[0].text).toBe(large);
	});

	test("archives the exact bytes and emits a stable hash/reference pointer", () => {
		const text = "确定性 evidence ✓\n" + "y".repeat(5_000);
		const message = toolResult("call-large", text);
		const next = evictToolResults(
			[message, ...Array.from({ length: 9 }, (_, index) => toolResult(`f-${index}`, "small"))],
			options({ currentHandoffStartedAt: undefined }),
		);
		const pointer = next[0].content[0].text as string;
		expect(pointer).toMatch(/\[archived tool result: sha256=[0-9a-f]{64} bytes=\d+ ref=tool-log\/session-a\/.+; retrieve with: code-agent evidence log .+\]/);
		const file = pointer.match(/ref=([^;]+);/)?.[1];
		expect(file).toBeDefined();
		expect(fs.readFileSync(path.join(root, "evidence", file!), "utf8")).toBe(text);
		const replay = evictToolResults(next, options({ currentHandoffStartedAt: undefined }));
		expect(replay[0].content[0].text).toBe(pointer);
	});

	test("thresholds are exclusive at both boundaries", () => {
		const exactly = toolResult("exact", "a".repeat(4_096));
		const above = toolResult("above", "a".repeat(4_097));
		const exactNext = evictToolResults(
			[exactly, ...Array.from({ length: 8 }, (_, i) => toolResult(`x-${i}`, "s"))],
			options(),
		);
		expect(exactNext[0].content[0].text).toBe("a".repeat(4_096));
		const oneAbove = evictToolResults(
			[above, ...Array.from({ length: 8 }, (_, i) => toolResult(`x-${i}`, "s"))],
			options(),
		)[0].content[0].text as string;
		expect(oneAbove).toContain("[archived tool result:");

		const shortHistory = evictToolResults(
			[above, ...Array.from({ length: 7 }, (_, i) => toolResult(`x-${i}`, "s"))],
			options(),
		);
		expect(shortHistory[0].content[0].text).not.toContain("[archived tool result:");
	});

	test("current-handoff messages stay verbatim", () => {
		const message = toolResult("current", "z".repeat(5_000), 200);
		const next = evictToolResults(
			[message, ...Array.from({ length: 10 }, (_, i) => toolResult(`x-${i}`, "s", 199))],
			options({ currentHandoffStartedAt: 200 }),
		);
		expect(next[0].content[0].text).toBe("z".repeat(5_000));
	});

	test("archive failure leaves the original context untouched", () => {
		const blocker = path.join(root, "blocker");
		fs.writeFileSync(blocker, "");
		const message = toolResult("blocked", "q".repeat(5_000));
		const next = evictToolResults(
			[message, ...Array.from({ length: 10 }, (_, i) => toolResult(`x-${i}`, "s"))],
			options({ archiveDir: blocker }),
		);
		expect(next[0].content[0].text).toBe("q".repeat(5_000));
	});

	test("the real extension hook is off-switchable and uses the current handoff boundary", async () => {
		const paths = new RunPaths(path.join(root, "runs", "code"), "run-eviction-test");
		const handoff = openHandoff(paths, {
			role: "coder",
			depth: 1,
			body: "Goal: archive context\n",
		});
		const saved: Record<string, string | undefined> = {};
		for (const key of ["CODEFLOW_RUN_ID", "CODEFLOW_RUNS_DIR", "CODEFLOW_HANDOFF_ID", "CODEFLOW_CONTEXT_EVICTION"]) {
			saved[key] = process.env[key];
		}
		process.env.CODEFLOW_RUN_ID = paths.runId;
		process.env.CODEFLOW_RUNS_DIR = paths.code;
		process.env.CODEFLOW_HANDOFF_ID = handoff.handoff_id;
		delete process.env.CODEFLOW_CONTEXT_EVICTION;
		const handlers: Record<string, any> = {};
		const mod = await import("../../runtime/extensions/codeflow-context/index.ts");
		mod.default({ on: (name: string, handler: any) => (handlers[name] = handler) } as never);
		const old = toolResult("extension-old", "o".repeat(5_000), 1);
		const current = toolResult("extension-current", "c".repeat(5_000), Date.now() + 10_000);
		const messages = [old, ...Array.from({ length: 10 }, (_, i) => toolResult(`x-${i}`, "s", 1)), current];
		const ctx = { sessionManager: { getSessionId: () => "session-extension" } };
		const result = handlers.context({ messages }, ctx);
		expect(result.messages[0].content[0].text).toContain("[archived tool result:");
		expect(result.messages.at(-1).content[0].text).toBe("c".repeat(5_000));

		process.env.CODEFLOW_CONTEXT_EVICTION = "off";
		expect(handlers.context({ messages }, ctx)).toBeUndefined();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
});
