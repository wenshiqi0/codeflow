import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunPaths } from "../../runtime/lib/paths";
import { createTask } from "../../runtime/lib/tasks";
import { commitmentForExecution, loadTerminalReceipt } from "../../runtime/lib/commitment";

const repository = path.resolve(import.meta.dir, "../..");
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function run(scenario: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-feedback-process-"));
	directories.push(dir);
	const paths = new RunPaths(path.join(dir, "runs"), "task-feedback-process");
	createTask(paths, "Independent Worker feedback must wake Root.");
	fs.mkdirSync(path.join(dir, "pi"), { recursive: true });
	fs.writeFileSync(path.join(dir, "pi/settings.json"), JSON.stringify({ retry: { enabled: true, baseDelayMs: 50, maxRetries: 1 } }));
	const child = Bun.spawn([
		process.execPath,
		path.join(repository, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
		"-p", "Coordinate the Task.", "--mode", "json", "--no-session",
		"--provider", "codeflow-feedback-offline", "--model", "manager",
		"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
		"--tools", "read,collaborate", "--extension", path.join(repository, "tests/fixtures/runtime/feedback-pi.ts"),
	], {
		cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe",
		env: { ...process.env, PI_CODING_AGENT_DIR: path.join(dir, "pi"),
			CODEFLOW_RUN_ID: paths.runId, CODEFLOW_RUNS_DIR: paths.code,
			CODEFLOW_GOAL_ID: paths.runId, CODEFLOW_PROCESS_KIND: "root",
			CODEFLOW_EXECUTION_ID: "exec-root", CODEFLOW_COMMITMENT_ID: "",
			CODEFLOW_PARENT_COMMITMENT_ID: "", CODEFLOW_TEST_DIR: dir, CODEFLOW_TEST_SCENARIO: scenario },
	});
	const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
	try {
		const [code, stdout, stderr] = await Promise.all([
			child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
		]);
		expect(stderr).not.toContain("Extension error");
		expect(stdout).not.toContain("No more responses");
		return { code, state: JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")), paths };
	} finally { clearTimeout(timeout); }
}

describe("real Pi nonblocking lifecycle (offline)", () => {
	test("a transient Root provider error does not cancel independent Children during Pi retry", async () => {
		const { code, state, paths } = await run("retry");
		expect(code).toBe(0);
		expect(state.killed).toEqual([]);
		expect(state.testerSeenWhileDeveloperLive).toBe(true);
		const root = commitmentForExecution(paths, "exec-root")!;
		expect(loadTerminalReceipt(paths, root.id)?.status).toBe("completed");
	}, 10_000);

	test("print mode survives natural Root endings and handles tester feedback while development is live", async () => {
		const { code, state, paths } = await run("feedback");
		expect(code).toBe(0);
		expect(state.testerSeenWhileDeveloperLive).toBe(true);
		expect(state.naturalEnds).toBeGreaterThan(1);
		expect(state.calls).toBeLessThan(15);
		expect(state.killed).toEqual([]);
		const root = commitmentForExecution(paths, "exec-root")!;
		expect(loadTerminalReceipt(paths, root.id)?.status).toBe("completed");
	}, 10_000);

	test("abort during idle feedback scheduling terminates Children and does not fabricate completion", async () => {
		const { state, paths } = await run("abort");
		expect(state.killed.sort()).toEqual(["exec-developer:SIGTERM", "exec-tester:SIGTERM"]);
		expect(state.calls).toBeLessThan(6);
		const root = commitmentForExecution(paths, "exec-root")!;
		expect(loadTerminalReceipt(paths, root.id)).toBeNull();
	}, 10_000);
});
