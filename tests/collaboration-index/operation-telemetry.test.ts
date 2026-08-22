import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	cleanupTmpDirs,
	loadBenchmarkModule,
	makeTmpDir,
	SNAPSHOT,
} from "../benchmark/helpers";

const LEDGER_EXT = path.resolve(
	import.meta.dir,
	"../../runtime/extensions/telemetry-ledger/index.ts",
);
let ledger: string;
const temporaryDirs: string[] = [];

afterEach(() => {
	fs.rmSync(ledger, { recursive: true, force: true });
	for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function fire(calls: Array<{ id: string; tool: string; command?: string }>) {
	ledger = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-operation-telemetry-"));
	const savedLedger = process.env.CODEFLOW_BENCHMARK_DRIVER_LEDGER_DIR;
	const savedRun = process.env.CODEFLOW_RUN_ID;
	const savedRole = process.env.CODEFLOW_AGENT_ROLE;
	process.env.CODEFLOW_BENCHMARK_DRIVER_LEDGER_DIR = ledger;
	process.env.CODEFLOW_RUN_ID = "run-operation-telemetry";
	process.env.CODEFLOW_AGENT_ROLE = "coder";
	const handlers = new Map<string, any>();
	const mod = await import(LEDGER_EXT);
	mod.default({ on: (name: string, handler: any) => handlers.set(name, handler) } as never);
	try {
		handlers.get("message_end")!({
			message: {
				role: "assistant",
				provider: "fixture",
				model: "fixture-model",
				timestamp: Date.parse("2026-01-01T00:00:00Z"),
				usage: { input: 1, output: 1, totalTokens: 2 },
			},
		});
		for (const call of calls) {
			handlers.get("tool_call")!({
				toolCallId: call.id,
				toolName: call.tool,
				input: call.command === undefined ? {} : { command: call.command },
			});
			handlers.get("tool_execution_end")!({
				toolCallId: call.id,
				toolName: call.tool,
				isError: false,
			});
		}
	} finally {
		if (savedLedger === undefined) delete process.env.CODEFLOW_BENCHMARK_DRIVER_LEDGER_DIR;
		else process.env.CODEFLOW_BENCHMARK_DRIVER_LEDGER_DIR = savedLedger;
		if (savedRun === undefined) delete process.env.CODEFLOW_RUN_ID;
		else process.env.CODEFLOW_RUN_ID = savedRun;
		if (savedRole === undefined) delete process.env.CODEFLOW_AGENT_ROLE;
		else process.env.CODEFLOW_AGENT_ROLE = savedRole;
	}
	return fs.readFileSync(path.join(ledger, "tool-calls.jsonl"), "utf8");
}

describe("privacy-safe collaboration operation telemetry", () => {
	test("classifies recall, index, evidence, edit, and explore without serializing commands", async () => {
		const output = await fire([
			{ id: "goal", tool: "bash", command: "code-agent goal list" },
			{ id: "index", tool: "bash", command: "code-agent handoff index --thread code" },
			{ id: "recall", tool: "bash", command: "code-agent handoff get --id h1" },
			{ id: "log", tool: "bash", command: "code-agent evidence log h1 --grep SECRET" },
			{ id: "edit", tool: "edit" },
			{ id: "read", tool: "read" },
		]);
		const rows = output.trim().split("\n").map((line) => JSON.parse(line));
		const requested = new Map(rows.filter((row) => row.kind === "requested").map((row) => [row.call_id, row]));
		expect(requested.get("goal")).toMatchObject({ operation_kind: "goal_list" });
		expect(requested.get("index")).toMatchObject({ operation_kind: "handoff_index" });
		expect(requested.get("recall")).toMatchObject({ operation_kind: "handoff_recall" });
		expect(requested.get("log")).toMatchObject({ operation_kind: "evidence_log" });
		expect(requested.get("edit")).toMatchObject({ operation_kind: "edit" });
		expect(requested.get("read")).toMatchObject({ operation_kind: "explore" });
		expect(output).not.toContain("--grep SECRET");
		expect(output).not.toContain("code-agent handoff");
	});

	test("benchmark runner preserves operation classifications in attempt ledgers", async () => {
		const mod = await loadBenchmarkModule();
		const outDir = makeTmpDir("codeflow-operation-runner-");
		temporaryDirs.push(outDir);
		await mod.runBenchmark({
			dataset: SNAPSHOT,
			instances: ["demo/demo-1001"],
			outDir,
			driver: {
				startAttempt() {
					return (async function* () {
						yield {
							type: "round",
							round: {
								role: "coder",
								provider: "fixture",
								model: "fixture-model",
								usage: {
									input: 1,
									output: 1,
									reasoning: 0,
									cache_read: 0,
									cache_write: 0,
									total_tokens: 2,
									cost: null,
								},
							},
						};
						yield {
							type: "tool_calls",
							role: "coder",
							provider: "fixture",
							model: "fixture-model",
							calls: [{
								call_id: "recall",
								tool: "bash",
								operation_kind: "handoff_recall",
								status: "succeeded",
							}],
						};
					})();
				},
			},
			evaluator: { async evaluate() { return "resolved"; } },
			clock: { now: () => 0 },
			codeflowCommit: "0".repeat(40),
		});
		const rows = fs.readFileSync(path.join(outDir, "cases", "demo__demo-1001", "attempts", "1", "tool-calls.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.operation_kind === "handoff_recall")).toBe(true);
	});
});
