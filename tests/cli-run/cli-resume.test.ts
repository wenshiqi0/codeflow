import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	finishHandoff,
	openHandoff,
	runStart,
	runnerExited,
} from "../../runtime/lib/handoff";
import { RunPaths, readJson } from "../../runtime/lib/paths";

const repo = path.resolve(import.meta.dir, "../..");
const codeflow = path.join(repo, "runtime/bin/codeflow");
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return root;
}

function baseEnv(): Record<string, string> {
	const env = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	delete env.CODEFLOW_RUN_ID;
	delete env.CODEFLOW_RUNS_DIR;
	return env;
}

function terminalSource(runsDir: string, requirement: string): RunPaths {
	const paths = new RunPaths(runsDir, "run-resume-cli");
	runStart(paths, "planner", 41001, requirement);
	const root = openHandoff(paths, {
		role: "planner",
		depth: 0,
		body: `Goal: ${requirement}\n`,
	});
	finishHandoff(paths, {
		handoffId: root.handoff_id,
		status: "BLOCKED",
		summary: "runtime correction required",
		blockedReasons: ["PROVIDER_FAILURE"],
	});
	runnerExited(paths, 41001, "planner", 0);
	return paths;
}

describe("external resume command", () => {
	test("continues the same run id and persistent planner session", () => {
		const fixture = temporaryRoot("codeflow-cli-resume-");
		const runsDir = path.join(fixture, "runs");
		const argsFile = path.join(fixture, "pi-args.json");
		const fakePi = path.join(fixture, "fake-pi.ts");
		fs.writeFileSync(
			fakePi,
			`import * as fs from "node:fs"; fs.writeFileSync(process.env.CODEFLOW_TEST_PI_ARGS as string, JSON.stringify(process.argv.slice(2)));`,
			"utf-8",
		);
		const original = "fix H3 multi-reference behavior\nwithout losing ordered inputs";
		const source = terminalSource(runsDir, original);
		fs.mkdirSync(source.goalDir("existing-goal"), { recursive: true });
		fs.writeFileSync(source.goalContractPath("existing-goal"), '{"goal_id":"existing-goal"}\n');
		fs.mkdirSync(source.piSessions, { recursive: true });
		fs.writeFileSync(path.join(source.piSessions, "existing-lane.jsonl"), "lane history\n");
		fs.writeFileSync(path.join(source.runDir, "facts.jsonl"), "confirmed fact\n");
		fs.mkdirSync(source.evidence, { recursive: true });
		fs.writeFileSync(path.join(source.evidence, "existing.txt"), "verified evidence\n");

		const result = Bun.spawnSync(["bash", codeflow, "resume", source.runId], {
			cwd: fixture,
			env: {
				...baseEnv(),
				CODEFLOW_RUNS_DIR: runsDir,
				CODEFLOW_PI_CLI: fakePi,
				CODEFLOW_TEST_PI_ARGS: argsFile,
			},
			timeout: 30_000,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toContain(`run_id=${source.runId}`);
		expect(result.stderr.toString()).toContain("resumed=true");
		expect(fs.readdirSync(runsDir).filter((name) => !name.startsWith("_"))).toEqual([source.runId]);

		const runner = readJson<Record<string, unknown>>(path.join(source.runDir, "runner.json"));
		expect(runner).toMatchObject({
			run_id: source.runId,
			requirement: original,
			resume_count: 1,
		});
		const argv = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
		expect(argv[argv.indexOf("--session-id") + 1]).toBe(`${source.runId}-planner`);
		expect(argv[argv.indexOf("-p") + 1]).toContain("Continue its existing immutable goals");
		expect(fs.readdirSync(source.handoffs).sort()).toEqual([
			"h00001-planner",
			"h00002-planner",
		]);
		expect(readJson<Record<string, unknown>>(source.statePath("h00001-planner"))).toMatchObject({
			status: "blocked",
		});
		expect(fs.readFileSync(source.goalContractPath("existing-goal"), "utf-8")).toContain("existing-goal");
		expect(fs.readFileSync(path.join(source.piSessions, "existing-lane.jsonl"), "utf-8")).toBe("lane history\n");
		expect(fs.readFileSync(path.join(source.runDir, "facts.jsonl"), "utf-8")).toBe("confirmed fact\n");
		expect(fs.readFileSync(path.join(source.evidence, "existing.txt"), "utf-8")).toBe("verified evidence\n");
		expect(fs.readdirSync(source.events).some((name) => name.includes("run_resumed--STARTED"))).toBeTrue();
	});

	test("refuses a run whose latest attempt is still active", () => {
		const fixture = temporaryRoot("codeflow-cli-resume-active-");
		const runsDir = path.join(fixture, "runs");
		const paths = new RunPaths(runsDir, "run-active");
		runStart(paths, "planner", process.pid, "still active");

		const result = Bun.spawnSync(["bash", codeflow, "resume", paths.runId], {
			cwd: fixture,
			env: { ...baseEnv(), CODEFLOW_RUNS_DIR: runsDir },
			timeout: 30_000,
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("not fully stopped");
		expect(fs.readdirSync(paths.events).filter((name) => name.includes("run_resumed"))).toEqual([]);
	});

	test("refuses resume from inside another Codeflow run", () => {
		const fixture = temporaryRoot("codeflow-cli-resume-inner-");
		const result = Bun.spawnSync(["bash", codeflow, "resume", "run-any"], {
			cwd: fixture,
			env: { ...baseEnv(), CODEFLOW_RUN_ID: "run-parent" },
			timeout: 30_000,
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("cannot run inside another Codeflow run");
	});
});
