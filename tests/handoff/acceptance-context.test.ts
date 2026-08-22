import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { finishHandoff, openHandoff, startHandoff } from "../../runtime/lib/handoff";
import { readJson, RunPaths } from "../../runtime/lib/paths";

let project: string;
let paths: RunPaths;
const savedProjectDir = process.env.CODEFLOW_PROJECT_DIR;

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-acceptance-context-"));
	process.chdir(project);
	process.env.CODEFLOW_PROJECT_DIR = project;
	fs.writeFileSync("base.txt", "base\n");
	fs.writeFileSync("closure.md", "closure\n");
	fs.mkdirSync(".git", { recursive: true });
	Bun.spawnSync(["git", "init"]);
	Bun.spawnSync(["git", "config", "user.email", "test@example.test"]);
	Bun.spawnSync(["git", "config", "user.name", "Test"]);
	Bun.spawnSync(["git", "add", "base.txt"]);
	Bun.spawnSync(["git", "commit", "-m", "base"]);
	paths = new RunPaths(".codeflow/runs/code", "run-acceptance-context");
});

afterEach(() => {
	const cwd = process.cwd();
	process.chdir(path.dirname(cwd));
	fs.rmSync(project, { recursive: true, force: true });
	if (savedProjectDir === undefined) delete process.env.CODEFLOW_PROJECT_DIR;
	else process.env.CODEFLOW_PROJECT_DIR = savedProjectDir;
});

function finishPass(role: string, depth: number, receiptName: string) {
	fs.writeFileSync(receiptName, JSON.stringify({ status: "PASS" }));
	const opened = openHandoff(paths, {
		role,
		depth,
		body: "Goal: mechanically classify workspace context\n",
	});
	startHandoff(paths, opened.handoff_id, process.pid);
	finishHandoff(paths, {
		handoffId: opened.handoff_id,
		status: "PASS",
		summary: "done",
		receipt: receiptName,
		artifacts: ["closure.md"],
	});
	return opened;
}

describe("mechanical acceptance context", () => {
	test("workspace changes during a PASS produce producer context", () => {
	const opened = openHandoff(paths, {
		role: "worker",
		depth: 1,
		body: "Goal: produce a change\n",
	});
	startHandoff(paths, opened.handoff_id, process.pid);
	fs.writeFileSync("product.txt", "changed\n");
	fs.writeFileSync("producer.json", JSON.stringify({ status: "PASS" }));
	finishHandoff(paths, {
		handoffId: opened.handoff_id,
		status: "PASS",
		summary: "produced",
		receipt: "producer.json",
	});
	expect(readJson<Record<string, unknown>>(paths.receiptPath(opened.handoff_id))).toMatchObject({
		status: "PASS",
		acceptance_context: "producer",
	});
	});

	test("an unchanged PASS remains fresh without blocking transition", () => {
		const opened = finishPass("worker", 1, "fresh.json");
		expect(readJson<Record<string, unknown>>(paths.receiptPath(opened.handoff_id))).toMatchObject({
			status: "PASS",
			acceptance_context: "fresh",
		});
	});

	test("the derivation is mirrored to independent telemetry", () => {
		const opened = finishPass("worker", 0, "root.json");
		const telemetry = fs
			.readFileSync(path.join(paths.runDir, "telemetry", "acceptance-context.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(telemetry).toHaveLength(1);
		expect(telemetry[0]).toMatchObject({
			handoff_id: opened.handoff_id,
			goal_id: null,
			thread: null,
			acceptance_context: "fresh",
			changed_files_delta: [],
		});
	});
});
