import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { parseExecArguments, resolveRunsDir } from "../../runtime/cli/run";

describe("run root resolution", () => {
	test("the default run root is absolute before a child changes worktree", () => {
		const launchRoot = path.join(path.parse(process.cwd()).root, "workspace", "main");
		expect(resolveRunsDir(undefined, launchRoot)).toBe(
			path.join(launchRoot, ".codeflow", "runs", "code"),
		);
	});

	test("an explicit relative run root is anchored to the launch checkout", () => {
		const launchRoot = path.join(path.parse(process.cwd()).root, "workspace", "main");
		expect(resolveRunsDir("../run-state", launchRoot)).toBe(
			path.join(path.dirname(launchRoot), "run-state"),
		);
	});
});

describe("exec arguments", () => {
	test("accepts an explicit Worker model before or after the objective", () => {
		expect(parseExecArguments(["--worker-model", "provider/model", "build", "it"])).toEqual({
			prompt: "build it",
			workerModel: "provider/model",
		});
		expect(parseExecArguments(["build it", "--worker-model=other/model"])).toEqual({
			prompt: "build it",
			workerModel: "other/model",
		});
	});

	test("preserves the configured default when no override is supplied", () => {
		expect(parseExecArguments(["build", "it"])).toEqual({ prompt: "build it", workerModel: undefined });
	});

	test("rejects missing, duplicate, and unknown options", () => {
		expect(() => parseExecArguments(["--worker-model"])).toThrow("--worker-model requires");
		expect(() => parseExecArguments(["--worker-model", "a/b", "--worker-model=c/d", "work"])).toThrow("only once");
		expect(() => parseExecArguments(["--other", "work"])).toThrow("unknown exec option: --other");
	});
});
