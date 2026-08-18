import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../../runtime/extensions/codeflow-context/index";

const repo = path.resolve(import.meta.dir, "../..");

describe("codeflow context extension", () => {
	test("resolves role prompt imports during before_agent_start", () => {
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
			const systemPrompt = fs.readFileSync(path.join(repo, "runtime/agents/planner.md"), "utf8");
			const result = handler({
				systemPrompt,
				systemPromptOptions: { cwd },
			}) as {
				systemPrompt: string;
				message: { content: string; details: { sources: Array<{ kind: string; ref: string }> } };
			};

			expect(result.systemPrompt).not.toContain("codeflow:import");
			expect(result.systemPrompt).not.toContain("references/capabilities/planning.md");

			expect(result.message.content).toContain("<context_imports>");
			expect(result.message.content).toContain("# Planning Capability");
			expect(result.message.content).toContain("# Engineering patterns");
			expect(result.message.content).toContain("# Handoff Contract");
			expect(result.message.details.sources.map((source) => source.ref)).toEqual(
				expect.arrayContaining([
					"references/capabilities/planning.md",
					"references/patterns.md",
					"references/capabilities/handoff.md",
				]),
			);
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
});
