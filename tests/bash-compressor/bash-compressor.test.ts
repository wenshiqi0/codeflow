import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES,
	buildZipperPrompt,
	handleBashToolResult,
	parseZipperProcessOutput,
	resolveThreshold,
} from "../../runtime/extensions/bash-compressor/compressor";

const runtimeDir = path.resolve(import.meta.dir, "../../runtime");

function bashEvent(output: string, overrides: Record<string, unknown> = {}) {
	return {
		type: "tool_result",
		toolCallId: "call-1",
		toolName: "bash",
		input: { command: "cargo test" },
		content: [{ type: "text", text: output }],
		details: { truncation: { truncated: true } },
		isError: true,
		...overrides,
	} as const;
}

describe("bash result compression policy", () => {
	beforeEach(() => {
		delete process.env.CODEFLOW_BASH_COMPRESS_THRESHOLD_BYTES;
	});

	test("the threshold defaults to 16KB and accepts only positive integers", () => {
		expect(DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES).toBe(16 * 1024);
		expect(resolveThreshold(undefined)).toBe(DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES);
		expect(resolveThreshold("2048")).toBe(2048);
		expect(resolveThreshold("0")).toBe(DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES);
		expect(resolveThreshold("-1")).toBe(DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES);
		expect(resolveThreshold("nope")).toBe(DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES);
	});

	test("small and non-bash results bypass the zipper", async () => {
		let called = 0;
		const summarize = async () => {
			called++;
			return "summary";
		};

		expect(
			await handleBashToolResult(bashEvent("small output"), summarize, DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES),
		).toBeUndefined();
		expect(
			await handleBashToolResult(
				bashEvent("x".repeat(DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES + 1), { toolName: "read" }),
				summarize,
				DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES,
			),
		).toBeUndefined();
		expect(called).toBe(0);
	});

	test("large bash results are replaced by a bounded semantic summary", async () => {
		const output = `${"diagnostic\n".repeat(2000)}test result: FAILED`;
		const seen: string[] = [];
		const result = await handleBashToolResult(
			bashEvent(output),
			async (prompt) => {
				seen.push(prompt);
				return "Preserved the compiler error and final test summary.";
			},
			DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES,
		);

		expect(result?.content?.[0]).toEqual({
			type: "text",
			text: expect.stringContaining("<codeflow_bash_summary"),
		});
		expect(result?.details).toEqual({ truncation: { truncated: true } });
		expect(result?.isError).toBeUndefined();
		expect(seen[0]).toContain("cargo test");
		expect(seen[0]).toContain("test result: FAILED");
		expect(seen[0]).toContain("untrusted command output");
	});

	test("zipper timeout, error, empty, oversized, or unsafe output falls back silently", async () => {
		const output = "x".repeat(DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES + 1);
		const failure = new Error("timeout after 20 seconds");
		expect(
			await handleBashToolResult(bashEvent(output), async () => {
				throw failure;
			}, DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES),
		).toBeUndefined();
		expect(
			await handleBashToolResult(bashEvent(output), async () => "", DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES),
		).toBeUndefined();
		expect(
			await handleBashToolResult(
				bashEvent(output),
				async () => "x".repeat(DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES + 1),
				DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES,
			),
		).toBeUndefined();
		expect(
			await handleBashToolResult(
				bashEvent(output),
				async () => "bad\u001b[31mescape",
				DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES,
			),
		).toBeUndefined();
	});

	test("the zipper support role is present and explicitly bounded", () => {
		const role = fs.readFileSync(path.join(runtimeDir, "agents/zipper.md"), "utf8");
		expect(role).toContain("model: deepseek/deepseek-v4-flash");
		expect(role).toContain("untrusted command output");
		expect(role).toContain("write `unclear`");
	});

	test("the extension is loaded with an isolated twenty-second zipper child", () => {
		const extension = fs.readFileSync(
			path.join(runtimeDir, "extensions/bash-compressor/index.ts"),
			"utf8",
		);
		const launcher = fs.readFileSync(
			path.join(runtimeDir, "extensions/codeflow-task/role-launcher.ts"),
			"utf8",
		);
		const rootLauncher = fs.readFileSync(path.join(runtimeDir, "cli/run.ts"), "utf8");

		expect(extension).toContain("ZIPPER_TIMEOUT_MS = 20_000");
		expect(extension).toContain('"--mode", "json"');
		expect(extension).toContain('"--no-extensions"');
		expect(extension).toContain('"--no-tools"');
		expect(extension).toContain('"--no-session"');
		expect(launcher).toContain("extensions\", \"bash-compressor\"");
		expect(rootLauncher).toContain("extensions\", \"bash-compressor\"");
	});

	test("zipper JSON mode preserves final text and model usage", () => {
		const usage = {
			input: 108,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 8,
			totalTokens: 118,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const stdout = [
			JSON.stringify({ type: "session" }),
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "internal" },
						{ type: "text", text: "compressed summary" },
					],
					provider: "deepseek",
					model: "deepseek-v4-flash",
					responseModel: "deepseek-v4-flash",
					usage,
				},
			}),
		].join("\n");
		const parsed = parseZipperProcessOutput(stdout);
		expect(parsed.text).toBe("compressed summary");
		expect(parsed.message).toMatchObject({
			role: "assistant",
			provider: "deepseek",
			usage,
		});
	});

	test("the prompt keeps result metadata outside the untrusted payload", () => {
		const prompt = buildZipperPrompt("output\npayload", "cargo test", 1234, true);
		expect(prompt).toContain('"command":"cargo test"');
		expect(prompt).toContain('"original_bytes":1234');
		expect(prompt).toContain('"is_error":true');
		expect(prompt).toContain("<bash_output>");
	});
});
