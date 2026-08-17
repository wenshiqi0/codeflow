import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	redactRuntimeReferences,
	runtimeBashViolation,
	runtimeReadViolation,
	runtimeWriteViolation,
} from "../../runtime/extensions/host-guard/policy";

const runtimeDir = path.resolve(import.meta.dir, "../../runtime");

describe("host runtime guard", () => {
	test("blocks writes inside the Codeflow runtime", () => {
		expect(runtimeWriteViolation(path.join(runtimeDir, "lib/paths.ts"))).toContain(
			"not product-run context",
		);
		expect(runtimeWriteViolation(path.join(process.cwd(), "src/app.ts"))).toBeNull();
	});

	test("blocks runtime inspection and environment references", () => {
		expect(runtimeBashViolation(`sed -i s/x/y/ ${runtimeDir}/lib/paths.ts`)).toContain(
			"not product-run context",
		);
		expect(runtimeReadViolation(path.join(runtimeDir, "agents/planner.md"))).toContain(
			"not product-run context",
		);
		expect(runtimeBashViolation("cat $PI_CODING_AGENT_DIR/AGENTS.md")).toContain(
			"not product-run context",
		);
		expect(runtimeBashViolation("rg graph src")).toBeNull();
		expect(runtimeBashViolation("ls $PI_CODING_AGENT_DIR/../references")).toContain(
			"not product-run context",
		);
		expect(runtimeBashViolation("cat > $PI_CODING_AGENT_DIR/lib/x")).toContain(
			"not product-run context",
		);
	});

	test("redacts runtime locations that leak through generic output", () => {
		const redacted = redactRuntimeReferences(
			`PI_CODING_AGENT_DIR=${runtimeDir}\nPATH=${runtimeDir}/bin:/usr/bin\n`,
		);
		expect(redacted).toContain("PI_CODING_AGENT_DIR=[redacted]");
		expect(redacted).toContain("[Codeflow runtime redacted]/bin");
		expect(redacted).not.toContain(runtimeDir);
	});

	test("extension terminates the role on a blocked tool call", async () => {
		const mod = await import("../../runtime/extensions/host-guard/index.ts");
		const handlers: Record<string, (event: unknown) => unknown> = {};
		const entries: unknown[] = [];
		const pi = {
			on: (kind: string, handler: (event: unknown) => unknown) => {
				handlers[kind] = handler;
			},
			appendEntry: (type: string, payload: unknown) => {
				entries.push({ type, payload });
			},
		};
		mod.default(pi as never);
		const result = handlers.tool_call({
			toolName: "write",
			input: { path: path.join(runtimeDir, "lib/paths.ts") },
		}) as { block: boolean; terminate: boolean; reason: string };
		expect(result).toMatchObject({
			block: true,
			terminate: true,
			reason: expect.stringContaining("not product-run context"),
		});
		expect(entries).toHaveLength(1);
	});

	test("extension redacts tool results", async () => {
		const mod = await import("../../runtime/extensions/host-guard/index.ts");
		const handlers: Record<string, (event: unknown) => unknown> = {};
		const pi = {
			on: (kind: string, handler: (event: unknown) => unknown) => {
				handlers[kind] = handler;
			},
			appendEntry: () => undefined,
		};
		mod.default(pi as never);
		const result = handlers.tool_result({
			content: [{ type: "text", text: `PATH=${runtimeDir}/bin` }],
		}) as { content: Array<{ text: string }> };
		expect(result.content[0]?.text).not.toContain(runtimeDir);
		expect(result.content[0]?.text).toContain("[Codeflow runtime redacted]/bin");
	});
});
