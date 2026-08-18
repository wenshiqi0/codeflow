import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../../runtime/extensions/codeflow-context/index";
import { resolveRole } from "../../runtime/lib/roles";

const repo = path.resolve(import.meta.dir, "../..");

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
				message: { content: string; details: { sources: Array<{ kind: string; ref: string }> } };
			};

			expect(result.systemPrompt).toContain("# Planner Capability");
			expect(result.systemPrompt).toContain("five read-only information calls or five minutes");
			expect(result.systemPrompt).not.toContain("codeflow:import");
			expect(result.message.content).not.toContain("<context_imports>");
			expect(result.message.details.sources.some((source) => source.kind === "context_import")).toBeFalse();
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
