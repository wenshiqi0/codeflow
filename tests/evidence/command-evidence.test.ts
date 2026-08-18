import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { finishHandoff, openHandoff } from "../../runtime/lib/handoff";
import { RunPaths } from "../../runtime/lib/paths";

const REPO = path.resolve(import.meta.dir, "../..");
const CODE_AGENT = path.join(REPO, "runtime", "bin", "code-agent");
const RUN_ID = "run-evidence-test";
const HANDOFF_ID = "h00002-verify";

let project: string;
let paths: RunPaths;
let env: Record<string, string>;

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-evidence-"));
	Bun.spawnSync(["git", "init", "-q"], { cwd: project });
	paths = new RunPaths(path.join(project, ".state", "code"), RUN_ID);
	env = Object.fromEntries(
		Object.entries({
			...process.env,
			CODEFLOW_RUN_ID: RUN_ID,
			CODEFLOW_HANDOFF_ID: HANDOFF_ID,
			CODEFLOW_RUNS_DIR: paths.code,
		}).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
});

afterEach(() => {
	fs.rmSync(project, { recursive: true, force: true });
});

function evidence(args: string[]) {
	return Bun.spawnSync(["bash", CODE_AGENT, "evidence", ...args], {
		cwd: project,
		env,
		timeout: 10_000,
	});
}

describe("mechanical command evidence", () => {
	test("records the real child exit code and complete stdout/stderr", () => {
		const result = evidence([
			"run",
			"--id",
			"failing",
			"--",
			"bash",
			"-c",
			"printf 'full stdout'; printf 'full stderr' >&2; exit 7",
		]);
		expect(result.exitCode).toBe(7);

		const commandDir = path.join(paths.evidence, HANDOFF_ID, "commands");
		const record = JSON.parse(fs.readFileSync(path.join(commandDir, "failing.json"), "utf8"));
		expect(record.status).toBe("FAIL");
		expect(record.exit_code).toBe(7);
		expect(record.command_argv).toEqual([
			"bash",
			"-c",
			"printf 'full stdout'; printf 'full stderr' >&2; exit 7",
		]);
		expect(fs.readFileSync(path.join(commandDir, "failing.stdout.log"), "utf8")).toBe(
			"full stdout",
		);
		expect(fs.readFileSync(path.join(commandDir, "failing.stderr.log"), "utf8")).toBe(
			"full stderr",
		);
	});

	test("aggregates command records into a validator-compatible batch", () => {
		openHandoff(paths, { role: "planner", depth: 0, body: "Goal: verify evidence\n" });
		const verify = openHandoff(paths, {
			role: "verify",
			depth: 1,
			body: "Goal: run checks\n",
		});
		expect(verify.handoff_id).toBe(HANDOFF_ID);
		expect(
			evidence(["run", "--id", "unit", "--", "bash", "-c", "printf ok"]).exitCode,
		).toBe(0);
		const output = path.join(project, "verify-receipt.json");
		const receipt = evidence(["receipt", "--output", output]);
		expect(receipt.exitCode).toBe(0);
		expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({
			status: "PASS",
			receipts: [{ id: "unit", status: "PASS", exit_code: 0 }],
		});
		expect(() =>
			finishHandoff(paths, {
				handoffId: verify.handoff_id,
				status: "PASS",
				summary: "checks passed",
				receipt: output,
			}),
		).not.toThrow();
	});

	test("classifies a command that cannot start without losing its error", () => {
		const result = evidence([
			"run",
			"--id",
			"missing",
			"--",
			"codeflow-command-that-does-not-exist",
		]);
		expect(result.exitCode).toBe(127);
		const commandDir = path.join(paths.evidence, HANDOFF_ID, "commands");
		const record = JSON.parse(fs.readFileSync(path.join(commandDir, "missing.json"), "utf8"));
		expect(record).toMatchObject({
			status: "FAIL",
			exit_code: 127,
			failure_class: "RUNNER_BLOCKED",
		});
		expect(fs.readFileSync(path.join(commandDir, "missing.stderr.log"), "utf8")).toContain(
			"failed to start",
		);
	});

	test("refuses to overwrite evidence with a duplicate id", () => {
		expect(evidence(["run", "--id", "unit", "--", "true"]).exitCode).toBe(0);
		const duplicate = evidence(["run", "--id", "unit", "--", "false"]);
		expect(duplicate.exitCode).not.toBe(0);
		expect(duplicate.stderr.toString()).toContain("already exists");
	});
});
