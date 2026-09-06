import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseExecArguments, resolveRunsDir, rootCommitmentForResume } from "../../runtime/cli/run";
import { claimTestWork } from "../runtime/helpers";
import { RunPaths } from "../../runtime/lib/paths";
import { createTask } from "../../runtime/lib/tasks";
import { AGENT_TOOL_ALLOWLIST, agentExtensions } from "../../runtime/lib/agent-launch";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

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

	test("resume never adopts a descendant Commitment on the root Goal", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-root-resume-"));
		dirs.push(dir);
		const paths = new RunPaths(dir, "task-resume");
		createTask(paths, "Deliver the outcome");
		const root = claimTestWork(paths, { goalId: paths.runId, work: "Own final delivery" });
		claimTestWork(paths, {
			goalId: paths.runId,
			parentCommitmentId: root.id,
			work: "Independently inspect the outcome",
		});
		expect(rootCommitmentForResume(paths)?.id).toBe(root.id);
	});
});

describe("exec arguments", () => {
	test("accepts one Agent model override before or after the objective", () => {
		expect(parseExecArguments(["--model", "agent/model", "build", "it"])).toEqual({
			prompt: "build it",
			model: "agent/model",
		});
		expect(parseExecArguments(["build it", "--model=agent/other"])).toEqual({
			prompt: "build it",
			model: "agent/other",
		});
	});

	test("preserves the configured default when no override is supplied", () => {
		expect(parseExecArguments(["build", "it"])).toEqual({
			prompt: "build it",
			model: undefined,
		});
	});

	test("rejects missing, duplicate, and unknown options", () => {
		expect(() => parseExecArguments(["--model"])).toThrow("--model requires");
		expect(() => parseExecArguments(["--model", "a/b", "--model=c/d", "work"])).toThrow("only once");
		expect(() => parseExecArguments(["--manager-model", "a/b", "work"])).toThrow("unknown exec option");
		expect(() => parseExecArguments(["--worker-model", "a/b", "work"])).toThrow("unknown exec option");
		expect(() => parseExecArguments(["--other", "work"])).toThrow("unknown exec option: --other");
	});
});

describe("root Agent launch boundary", () => {
	test("a CLI override pins the run-scoped model and full Agent capabilities", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-root-launch-"));
		dirs.push(dir);
		const capture = path.join(dir, "capture.json");
		const fakePi = path.join(dir, "fake-pi.ts");
		fs.writeFileSync(fakePi, `
			import * as fs from "node:fs";
			fs.writeFileSync(process.env.CODEFLOW_TEST_CAPTURE!, JSON.stringify({
				args: process.argv.slice(2),
				model: process.env.CODEFLOW_AGENT_MODEL,
				parent: process.env.CODEFLOW_PARENT_COMMITMENT_ID ?? null,
				team: process.env.CODEFLOW_TEAM_AGENT_ID ?? null,
				teamRunner: process.env.CODEFLOW_TEAM_RUNNER_PID ?? null,
				shellReady: process.env.CODEFLOW_TEAM_SHELL_READY ?? null,
				task: process.env.CODEFLOW_RUN_ID,
			}));
		`);
		const runtimeDir = path.resolve(import.meta.dir, "../../runtime");
		const env = { ...process.env };
		delete env.CODEFLOW_RUN_ID;
		const result = Bun.spawnSync([
			process.execPath, path.join(runtimeDir, "cli/run.ts"),
			"exec", "--model", "explicit-provider/explicit-model", "Exercise launch only",
		], {
			cwd: dir,
			env: {
				...env,
				CODEFLOW_PI_CLI: fakePi,
				CODEFLOW_TEST_CAPTURE: capture,
				CODEFLOW_RUNS_DIR: path.join(dir, "runs"),
				CODEFLOW_AGENT_MODEL: "environment-provider/environment-model",
				CODEFLOW_PARENT_COMMITMENT_ID: "unrelated-parent",
				CODEFLOW_RUN_ID: "task-calling-worker",
				CODEFLOW_EXECUTION_ID: "exec-calling-worker",
				CODEFLOW_TEAM_AGENT_ID: "agent-calling-worker",
				CODEFLOW_TEAM_RUNNER_PID: "1234",
				CODEFLOW_TEAM_SHELL_READY: "exec-calling-worker",
			},
			timeout: 5_000,
		});
		// The stand-in deliberately claims no work and cannot complete this Task.
		expect(result.exitCode).toBe(1);
		const observed = JSON.parse(fs.readFileSync(capture, "utf8"));
		expect(observed.model).toBe("explicit-provider/explicit-model");
		expect(observed.parent).toBeNull();
		expect(observed.team).toBeNull();
		expect(observed.teamRunner).toBeNull();
		expect(observed.shellReady).toBeNull();
		expect(observed.task).not.toBe("task-calling-worker");
		const args: string[] = observed.args;
		expect(args[args.indexOf("--provider") + 1]).toBe("explicit-provider");
		expect(args[args.indexOf("--model") + 1]).toBe("explicit-model");
		expect(args[args.indexOf("--tools") + 1]).toBe(AGENT_TOOL_ALLOWLIST.join(","));
		expect(args.filter((arg, index) => args[index - 1] === "--extension"))
			.toEqual(agentExtensions(runtimeDir));
		expect(args[args.indexOf("--append-system-prompt") + 1])
			.toBe(fs.readFileSync(path.join(runtimeDir, "../references/agent.md"), "utf8"));
	});
});
