import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defineGoal } from "../../runtime/lib/goals";
import { RunPaths } from "../../runtime/lib/paths";
import {
	bashViolation,
	pathViolation,
	rolePolicyConfig,
} from "../../runtime/extensions/directory-policy/policy";

let project: string;
let paths: RunPaths;

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-policy-"));
	process.chdir(project);
	paths = new RunPaths(".codeflow/runs/code", "run-policy-test");
	process.env.CODEFLOW_RUN_ID = paths.runId;
	process.env.CODEFLOW_RUNS_DIR = ".codeflow/runs/code";
});

afterEach(() => {
	delete process.env.CODEFLOW_RUN_ID;
	delete process.env.CODEFLOW_RUNS_DIR;
	delete process.env.CODEFLOW_GOAL_ID;
	delete process.env.CODEFLOW_LANE;
	const cwd = process.cwd();
	process.chdir(path.dirname(cwd));
	fs.rmSync(project, { recursive: true, force: true });
});

function setGoal(lane: "test" | "code" | "verify") {
	const goal = defineGoal(paths, {
		id: "movement-r1",
		goal: "movement",
		codeScope: ["src/game/physics.ts"],
	});
	process.env.CODEFLOW_GOAL_ID = goal.goal_id;
	process.env.CODEFLOW_LANE = lane;
}

describe("role policy configuration", () => {
	test("worker roles declare goal lanes and write policies", () => {
		expect(rolePolicyConfig("test-writer")).toEqual({
			goalLane: "test",
			writeMode: "allow",
			writeRoots: ["goal"],
			bashMode: "codeflow-only",
		});
		expect(rolePolicyConfig("coder")?.goalLane).toBe("code");
		expect(rolePolicyConfig("test-runner")?.goalLane).toBe("verify");
		expect(rolePolicyConfig("command")).toBeNull();
	});

});

describe("path policy", () => {
	test("test lane writes only its goal business tests and evidence", () => {
		setGoal("test");
		expect(pathViolation("test-writer", project, "tests/biz/movement-r1/physics.test.ts")).toBeNull();
		expect(
			pathViolation(
				"test-writer",
				project,
				".codeflow/runs/evidence/run-policy-test/goals/movement-r1/test/receipt.json",
			),
		).toBeNull();
		expect(pathViolation("test-writer", project, "src/game/physics.ts")).toContain(
			"test-writer may write only under",
		);
	});

	test("a goal-lane role cannot bypass policy by omitting goal context", () => {
		delete process.env.CODEFLOW_GOAL_ID;
		delete process.env.CODEFLOW_LANE;
		expect(
			pathViolation("test-writer", project, ".codeflow/runs/evidence/any.json"),
		).toContain("test-writer may write only under:");
	});

	test("code lane writes goal product scope and unit tests", () => {
		setGoal("code");
		expect(pathViolation("coder", project, "src/game/physics.ts")).toBeNull();
		expect(pathViolation("coder", project, "tests/unit/movement-r1/physics.test.ts")).toBeNull();
		expect(pathViolation("coder", project, "tests/fixtures/movement-r1/input.json")).toBeNull();
		expect(pathViolation("coder", project, "tests/biz/movement-r1/physics.test.ts")).toContain(
			"coder may write only under",
		);
	});

	test("verify lane writes only evidence", () => {
		setGoal("verify");
		expect(
			pathViolation(
				"test-runner",
				project,
				".codeflow/runs/evidence/run-policy-test/goals/movement-r1/verify/receipt.json",
			),
		).toBeNull();
		expect(pathViolation("test-runner", project, "src/game/physics.ts")).toContain(
			"test-runner may write only under",
		);
	});

	test("a symlink cannot escape an allowed goal root", () => {
		setGoal("test");
		fs.mkdirSync(path.join(project, "outside"), { recursive: true });
		fs.mkdirSync(path.join(project, "tests"), { recursive: true });
		fs.symlinkSync(path.join(project, "outside"), path.join(project, "tests/biz"));
		expect(pathViolation("test-writer", project, "tests/biz/movement-r1/leak.ts")).toContain(
			"test-writer may write only under",
		);
	});
});

describe("bash policy", () => {
	test("test-writer can only finish its handoff through bash", () => {
		expect(bashViolation("test-writer", "code-agent handoff finish --id h1")).toBeNull();
		expect(bashViolation("test-writer", "npm test")).toContain(
			"limited to \"code-agent handoff finish\"",
		);
	});

	test("coder and runner may run guarded work commands without composition", () => {
		expect(bashViolation("coder", "npm test")).toBeNull();
		expect(bashViolation("coder", "echo x > tests/biz/a.test.ts")).toContain(
			"may not use shell composition",
		);
		expect(bashViolation("test-runner", "npm test -- tests/biz/movement-r1")).toBeNull();
		expect(bashViolation("coder", "sed -i s/x/y/ tests/biz/a.test.ts")).toContain(
			"outside the development allowlist",
		);
		expect(bashViolation("coder", "node -e 'fs.writeFileSync(\"x\", \"y\")'")).toContain(
			"may not evaluate inline code",
		);
		expect(bashViolation("test-runner", "npm run test:biz")).toBeNull();
		expect(bashViolation("planner", "rg createGame src")).toBeNull();
		expect(bashViolation("planner", "npm install")).toContain(
			"limited to read-only inspection commands",
		);
		expect(bashViolation("supervisor", "code-agent verify patch tests.patch")).toBeNull();
		expect(bashViolation("supervisor", "npm install")).toContain(
			"limited to read-only inspection commands",
		);
	});
});
