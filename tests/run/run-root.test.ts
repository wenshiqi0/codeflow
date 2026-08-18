import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { resolveRunsDir } from "../../runtime/cli/run";

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
