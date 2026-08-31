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
	test("accepts independent Manager and Worker model overrides before or after the objective", () => {
		expect(parseExecArguments(["--manager-model", "manager/model", "--worker-model", "worker/model", "build", "it"])).toEqual({
			prompt: "build it",
			managerModel: "manager/model",
			workerModel: "worker/model",
		});
		expect(parseExecArguments(["build it", "--manager-model=manager/other", "--worker-model=worker/other"])).toEqual({
			prompt: "build it",
			managerModel: "manager/other",
			workerModel: "worker/other",
		});
	});

	test("preserves the configured default when no override is supplied", () => {
		expect(parseExecArguments(["build", "it"])).toEqual({
			prompt: "build it",
			managerModel: undefined,
			workerModel: undefined,
		});
	});

	test("rejects missing, duplicate, and unknown options", () => {
		expect(() => parseExecArguments(["--manager-model"])).toThrow("--manager-model requires");
		expect(() => parseExecArguments(["--worker-model"])).toThrow("--worker-model requires");
		expect(() => parseExecArguments(["--manager-model", "a/b", "--manager-model=c/d", "work"])).toThrow("only once");
		expect(() => parseExecArguments(["--worker-model", "a/b", "--worker-model=c/d", "work"])).toThrow("only once");
		expect(() => parseExecArguments(["--other", "work"])).toThrow("unknown exec option: --other");
	});
});
