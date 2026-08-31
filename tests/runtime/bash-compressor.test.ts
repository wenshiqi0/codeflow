import { expect, test } from "bun:test";
import {
	DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES,
	handleBashToolResult,
	MAX_ZIPPER_OUTPUT_BYTES,
	resolveThreshold,
	validZipperOutput,
} from "../../runtime/extensions/bash-compressor/compressor";

test("bash compression defaults to 12 KiB and accepts a positive integer override", () => {
	expect(DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES).toBe(12 * 1024);
	expect(resolveThreshold(undefined)).toBe(DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES);
	expect(resolveThreshold("0")).toBe(DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES);
	expect(resolveThreshold("8192")).toBe(8192);
});

test("zipper output is bounded to 4000 UTF-8 bytes", () => {
	expect(MAX_ZIPPER_OUTPUT_BYTES).toBe(4_000);
	expect(validZipperOutput("x".repeat(MAX_ZIPPER_OUTPUT_BYTES), 20_000, 12 * 1024)).toBe(true);
	expect(validZipperOutput("x".repeat(MAX_ZIPPER_OUTPUT_BYTES + 1), 20_000, 12 * 1024)).toBe(false);
});

test("bash compression only replaces oversized output with a valid summary", async () => {
	let calls = 0;
	const zipper = async () => {
		calls += 1;
		return "one failing test: expected 2, received 1";
	};
	const small = await handleBashToolResult({
		toolName: "bash",
		input: { command: "bun test" },
		content: [{ type: "text", text: "short" }],
	}, zipper);
	expect(small).toBeUndefined();
	expect(calls).toBe(0);

	const large = await handleBashToolResult({
		toolName: "bash",
		input: { command: "bun test" },
		content: [{ type: "text", text: "x".repeat(DEFAULT_BASH_COMPRESS_THRESHOLD_BYTES + 1) }],
	}, zipper);
	expect(calls).toBe(1);
	expect(large?.content[0]?.text).toContain("one failing test");
});
