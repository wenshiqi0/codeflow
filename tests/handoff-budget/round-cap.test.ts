import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openHandoff } from "../../runtime/lib/handoff";
import { RunPaths } from "../../runtime/lib/paths";

let project: string;
let paths: RunPaths;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-round-cap-"));
	paths = new RunPaths(path.join(project, ".codeflow", "runs", "code"), "run-round-cap-test");
	for (const key of [
		"CODEFLOW_RUN_ID",
		"CODEFLOW_RUNS_DIR",
		"CODEFLOW_HANDOFF_ID",
		"CODEFLOW_AGENT_ROLE",
		"CODEFLOW_HANDOFF_ROUND_CAP",
	]) {
		savedEnv[key] = process.env[key];
	}
	process.env.CODEFLOW_RUN_ID = paths.runId;
	process.env.CODEFLOW_RUNS_DIR = paths.code;
	process.env.CODEFLOW_AGENT_ROLE = "tester";
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	fs.rmSync(project, { recursive: true, force: true });
});

async function extension() {
	const handlers: Record<string, any> = {};
	const mod = await import("../../runtime/extensions/usage-ledger/index.ts");
	mod.default({ on: (name: string, handler: any) => (handlers[name] = handler) } as never);
	return { handlers, mod };
}

function messageEnd(withUsage = true): any {
	return {
		message: {
			role: "assistant",
			provider: "fixture",
			model: "fixture-model",
			timestamp: Date.now(),
			...(withUsage
				? {
						usage: { input: 10, output: 1, cacheRead: 20, cacheWrite: 0, totalTokens: 31 },
					}
				: {}),
		},
	};
}

function openTesterHandoff(): string {
	const handoff = openHandoff(paths, {
		role: "tester",
		depth: 1,
		body: "Goal: cap rounds\n",
	});
	process.env.CODEFLOW_HANDOFF_ID = handoff.handoff_id;
	return handoff.handoff_id;
}

describe("per-handoff round caps", () => {
	test("the next provider request after 25 tester rounds is blocked and aborted", async () => {
		const { handlers, mod } = await extension();
		const handoffId = openTesterHandoff();
		expect(mod.resolveHandoffRoundCap("tester")).toBe(25);
		const aborted: string[] = [];
		const ctx = { abort: () => aborted.push("abort") };
		for (let index = 0; index < 25; index++) handlers.message_end(messageEnd(), {});
		handlers.before_provider_request({}, ctx);
		const state = JSON.parse(fs.readFileSync(paths.statePath(handoffId), "utf8"));
		expect(state.status).toBe("blocked");
		expect(state.blocked.reasons).toEqual(["CONTEXT_BUDGET_EXCEEDED"]);
		expect(state.summary).toBe("handoff round cap 25 reached");
		expect(aborted).toEqual(["abort"]);
	});

	test("cap zero and failed model attempts do not trigger", async () => {
		const { handlers, mod } = await extension();
		openTesterHandoff();
		process.env.CODEFLOW_HANDOFF_ROUND_CAP = "0";
		expect(mod.resolveHandoffRoundCap("tester")).toBe(0);
		const aborted: string[] = [];
		const ctx = { abort: () => aborted.push("abort") };
		for (let index = 0; index < 30; index++) handlers.message_end(messageEnd(index === 0), {});
		handlers.before_provider_request({}, ctx);
		expect(aborted).toEqual([]);
	});

	test("environment override validates as a non-negative integer", async () => {
		const { mod } = await extension();
		expect(mod.resolveHandoffRoundCap("tester", { CODEFLOW_HANDOFF_ROUND_CAP: "7" })).toBe(7);
		expect(() => mod.resolveHandoffRoundCap("tester", { CODEFLOW_HANDOFF_ROUND_CAP: "-1" })).toThrow();
	});

	test("a published cap is idempotent across repeated provider requests", async () => {
		const { handlers } = await extension();
		const handoffId = openTesterHandoff();
		const aborted: string[] = [];
		const ctx = { abort: () => aborted.push("abort") };
		for (let index = 0; index < 25; index++) handlers.message_end(messageEnd(), {});
		handlers.before_provider_request({}, ctx);
		handlers.before_provider_request({}, ctx);
		const state = JSON.parse(fs.readFileSync(paths.statePath(handoffId), "utf8"));
		expect(state.status).toBe("blocked");
		expect(aborted).toEqual(["abort"]);
	});
});
