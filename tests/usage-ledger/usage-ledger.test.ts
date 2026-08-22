import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readUsageRecords } from "../../runtime/lib/usage";
import { openHandoff } from "../../runtime/lib/handoff";
import { RunPaths } from "../../runtime/lib/paths";

let project: string;
let paths: RunPaths;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-usage-ledger-"));
	paths = new RunPaths(path.join(project, ".codeflow", "runs", "code"), "run-usage-ledger-test");
	for (const key of [
		"CODEFLOW_RUN_ID",
		"CODEFLOW_RUNS_DIR",
		"CODEFLOW_HANDOFF_ID",
		"CODEFLOW_AGENT_ROLE",
		"CODEFLOW_AGENT_DEPTH",
	]) {
		savedEnv[key] = process.env[key];
	}
	process.env.CODEFLOW_RUN_ID = paths.runId;
	process.env.CODEFLOW_RUNS_DIR = paths.code;
	process.env.CODEFLOW_AGENT_ROLE = "worker";
	process.env.CODEFLOW_AGENT_DEPTH = "1";
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

function messageEnd(turn: number): any {
	return {
		message: {
			role: "assistant",
			provider: "fixture",
			model: "fixture-model",
			timestamp: Date.now(),
			usage: { input: 10 * turn, output: turn, cacheRead: 20, cacheWrite: 0, totalTokens: 31 * turn },
		},
	};
}

describe("usage ledger", () => {
	test("usage rows remain attributed observations without a provider-request gate", async () => {
		const { handlers } = await extension();
		const handoff = openHandoff(paths, { role: "worker", depth: 1, body: "Goal: work\n" });
		process.env.CODEFLOW_HANDOFF_ID = handoff.handoff_id;

		handlers.turn_start({ turnIndex: 0 });
		handlers.message_end(messageEnd(1));
		handlers.turn_start({ turnIndex: 1 });
		handlers.message_end(messageEnd(2));

		expect(Object.keys(handlers).sort()).toEqual(["message_end", "turn_start"]);
		const records = readUsageRecords(paths);
		expect(records.map((record) => record.turn)).toEqual([1, 2]);
		expect(records.every((record) => record.handoff_id === handoff.handoff_id)).toBe(true);
		expect(records.reduce((sum, record) => sum + record.usage.total_tokens, 0)).toBe(93);
		const state = JSON.parse(fs.readFileSync(paths.statePath(handoff.handoff_id), "utf8"));
		expect(state.status).toBe("open");
	});
});
