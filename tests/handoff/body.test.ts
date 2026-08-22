import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openHandoff } from "../../runtime/lib/handoff";
import { RunPaths } from "../../runtime/lib/paths";

const REPO = path.resolve(import.meta.dir, "../..");
const CODE_AGENT = path.join(REPO, "runtime", "bin", "code-agent");
let project: string;
let paths: RunPaths;

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-body-cli-"));
	paths = new RunPaths(path.join(project, ".codeflow", "runs", "code"), "run-body-cli-test");
});

afterEach(() => {
	fs.rmSync(project, { recursive: true, force: true });
});

function cli(args: string[]) {
	return Bun.spawnSync(["bash", CODE_AGENT, "handoff", ...args], {
		cwd: project,
		env: {
			...process.env,
			CODEFLOW_RUN_ID: paths.runId,
			CODEFLOW_RUNS_DIR: paths.code,
		},
	});
}

describe("handoff body retrieval", () => {
	test("returns the opened body byte-for-byte", () => {
		const body = "Outcome: exact body\nIntent: preserve every byte\n\nNested content\n";
		const handoff = openHandoff(paths, { role: "coder", depth: 1, body });
		const result = cli(["body", "--id", handoff.handoff_id]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe(body);
	});

	test("an unknown handoff fails without fabricating a body", () => {
		const result = cli(["body", "--id", "h99999-coder"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("handoff body not found: h99999-coder");
	});
});
