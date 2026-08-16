import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	runtimeBashViolation,
	runtimeWriteViolation,
} from "../../runtime/extensions/host-guard/policy";

const runtimeDir = path.resolve(import.meta.dir, "../../runtime");

describe("host runtime guard", () => {
	test("blocks writes inside the Codeflow runtime", () => {
		expect(runtimeWriteViolation(path.join(runtimeDir, "lib/paths.ts"))).toContain(
			"Codeflow runtime is read-only",
		);
		expect(runtimeWriteViolation(path.join(process.cwd(), "src/app.ts"))).toBeNull();
	});

	test("blocks runtime paths and environment references in bash", () => {
		expect(runtimeBashViolation(`sed -i s/x/y/ ${runtimeDir}/lib/paths.ts`)).toContain(
			"Codeflow runtime is read-only",
		);
		expect(runtimeBashViolation("cat $PI_CODING_AGENT_DIR/AGENTS.md")).toBeNull();
		expect(runtimeBashViolation("rg graph src")).toBeNull();
		expect(runtimeBashViolation("ls $PI_CODING_AGENT_DIR/../references")).toBeNull();
		expect(runtimeBashViolation("cat > $PI_CODING_AGENT_DIR/lib/x")).toContain(
			"Codeflow runtime is read-only",
		);
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
			reason: expect.stringContaining("read-only"),
		});
		expect(entries).toHaveLength(1);
	});
});
