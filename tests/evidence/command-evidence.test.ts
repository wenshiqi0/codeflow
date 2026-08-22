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
const sideEffects: string[] = [];

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
	for (const sideEffect of sideEffects.splice(0)) {
		fs.rmSync(sideEffect, { force: true });
	}
});

function evidence(args: string[]) {
	return Bun.spawnSync(["bash", CODE_AGENT, "evidence", ...args], {
		cwd: project,
		env,
		timeout: 10_000,
	});
}

function record(id: string): any {
	return JSON.parse(
		fs.readFileSync(path.join(paths.evidence, HANDOFF_ID, "commands", `${id}.json`), "utf8"),
	);
}

function commitBase(): void {
	fs.writeFileSync(path.join(project, "base.txt"), "base\n");
	Bun.spawnSync(["git", "add", "."], { cwd: project });
	Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test.invalid", "commit", "-m", "base"], {
		cwd: project,
	});
}

function outsideSideEffect(name: string): string {
	const file = path.join(path.dirname(project), `${path.basename(project)}-${name}`);
	fs.writeFileSync(file, "");
	sideEffects.push(file);
	return file;
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

describe("content-aware evidence dedupe", () => {
	test("replays an identical command on an unchanged tree without executing it twice", () => {
		commitBase();
		const sideEffect = outsideSideEffect("side-1");
		const argv = ["bash", "-c", `printf x >> ${JSON.stringify(sideEffect)}`];
		expect(evidence(["run", "--id", "first", "--", ...argv]).exitCode).toBe(0);
		expect(evidence(["run", "--id", "second", "--", ...argv]).exitCode).toBe(0);
		expect(fs.readFileSync(sideEffect, "utf8")).toBe("x");
		expect(record("second")).toMatchObject({
			deduped: true,
			deduped_from: "first",
			exit_code: 0,
			status: "PASS",
		});
	});

	test("changing tracked or untracked content invalidates the fingerprint", () => {
		commitBase();
		const sideEffect = outsideSideEffect("side-2");
		const argv = ["bash", "-c", `printf x >> ${JSON.stringify(sideEffect)}`];
		evidence(["run", "--id", "tracked-before", "--", ...argv]);
		fs.writeFileSync(path.join(project, "base.txt"), "changed tracked content\n");
		evidence(["run", "--id", "tracked-after", "--", ...argv]);
		expect(record("tracked-after").deduped).toBeUndefined();
		expect(fs.readFileSync(sideEffect, "utf8")).toBe("xx");

		fs.writeFileSync(sideEffect, "");
		evidence(["run", "--id", "untracked-before", "--", ...argv]);
		fs.writeFileSync(path.join(project, "untracked.txt"), "first\n");
		evidence(["run", "--id", "untracked-after", "--", ...argv]);
		fs.writeFileSync(path.join(project, "untracked.txt"), "same status, different bytes\n");
		evidence(["run", "--id", "untracked-changed", "--", ...argv]);
		expect(record("untracked-before").deduped).toBe(true);
		expect(record("untracked-after").deduped).toBeUndefined();
		expect(record("untracked-changed").deduped).toBeUndefined();
		expect(fs.readFileSync(sideEffect, "utf8")).toBe("xx");
	});

	test("unchanged FAIL evidence deduplicates, then a tree change forces a real rerun", () => {
		commitBase();
		const sideEffect = outsideSideEffect("side-3");
		const argv = ["bash", "-c", `printf x >> ${JSON.stringify(sideEffect)}; exit 7`];
		expect(evidence(["run", "--id", "fail-before", "--", ...argv]).exitCode).toBe(7);
		expect(evidence(["run", "--id", "fail-replay", "--", ...argv]).exitCode).toBe(7);
		expect(fs.readFileSync(sideEffect, "utf8")).toBe("x");
		expect(record("fail-replay")).toMatchObject({ deduped: true, status: "FAIL", exit_code: 7 });

		fs.writeFileSync(path.join(project, "base.txt"), "repair changes the tree\n");
		expect(evidence(["run", "--id", "fail-after-repair", "--", ...argv]).exitCode).toBe(7);
		expect(fs.readFileSync(sideEffect, "utf8")).toBe("xx");
		expect(record("fail-after-repair").deduped).toBeUndefined();
	});

	test("--no-dedupe and CODEFLOW_EVIDENCE_DEDUPE=off bypass the cache", () => {
		commitBase();
		const sideEffect = outsideSideEffect("side-4");
		const argv = ["bash", "-c", `printf x >> ${JSON.stringify(sideEffect)}`];
		evidence(["run", "--id", "flag-first", "--", ...argv]);
		evidence(["run", "--id", "flag-second", "--no-dedupe", "--", ...argv]);
		expect(fs.readFileSync(sideEffect, "utf8")).toBe("xx");

		fs.writeFileSync(sideEffect, "");
		env.CODEFLOW_EVIDENCE_DEDUPE = "off";
		evidence(["run", "--id", "env-first", "--", ...argv]);
		evidence(["run", "--id", "env-second", "--", ...argv]);
		expect(fs.readFileSync(sideEffect, "utf8")).toBe("xx");
	});

	test("a directory without HEAD silently disables dedupe", () => {
		const sideEffect = outsideSideEffect("side-5");
		const argv = ["bash", "-c", `printf x >> ${JSON.stringify(sideEffect)}`];
		evidence(["run", "--id", "no-git-first", "--", ...argv]);
		evidence(["run", "--id", "no-git-second", "--", ...argv]);
		expect(fs.readFileSync(sideEffect, "utf8")).toBe("xx");
		expect(record("no-git-second").deduped).toBeUndefined();
	});

	test("receipt aggregation keeps deduped provenance but counts unique executions", () => {
		commitBase();
		const sideEffect = outsideSideEffect("side-6");
		const argv = ["bash", "-c", `printf x >> ${JSON.stringify(sideEffect)}`];
		evidence(["run", "--id", "receipt-first", "--", ...argv]);
		evidence(["run", "--id", "receipt-second", "--", ...argv]);
		const output = path.join(project, "dedupe-receipt.json");
		const result = evidence(["receipt", "--output", output]);
		expect(result.exitCode).toBe(0);
		const printed = JSON.parse(result.stdout.toString());
		expect(printed.count).toBe(1);
		const receipt = JSON.parse(fs.readFileSync(output, "utf8"));
		expect(receipt.receipts).toHaveLength(2);
		expect(receipt.receipts[1]).toMatchObject({
			deduped: true,
			deduped_from: "receipt-first",
		});
	});
});

describe("bounded evidence log retrieval", () => {
	test("tool-log defaults to bounded head and tail bytes", () => {
		const directory = path.join(paths.evidence, "tool-log", "session-a");
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, "tool-log.txt"), "a".repeat(5_000) + "\nTAIL-MARKER\n", "utf8");
		const result = evidence(["log", "tool-log"]);
		expect(result.exitCode).toBe(0);
		const output = result.stdout.toString();
		expect(output.length).toBeLessThan(4_300);
		expect(output).toContain("[omitted ");
		expect(output).toContain("TAIL-MARKER");
	});

	test("grep returns matching lines with three lines of context", () => {
		const directory = path.join(paths.evidence, "tool-log", "session-b");
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(
			path.join(directory, "grep-log.txt"),
			["one", "two", "three", "NEEDLE", "four", "five", "six", "seven"].join("\n") + "\n",
			"utf8",
		);
		const result = evidence(["log", "grep-log", "--grep", "NEEDLE"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().split("\n")).toEqual([
			"one",
			"two",
			"three",
			"NEEDLE",
			"four",
			"five",
			"six",
			"",
		]);
	});

	test("recorder entries read their stdout and stderr refs", () => {
		commitBase();
		evidence([
			"run",
			"--id",
			"retrievable",
			"--",
			"bash",
			"-c",
			"printf 'command stdout\\n'; printf 'command stderr\\n' >&2",
		]);
		const result = evidence(["log", "retrievable", "--grep", "command"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("command: bash -c");
		expect(result.stdout.toString()).toContain("command stdout");
		expect(result.stdout.toString()).toContain("command stderr");
	});

	test("an unknown id is a single-line non-zero error", () => {
		const result = evidence(["log", "does-not-exist"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString().trim()).toBe(
			"code-agent evidence: error: evidence log not found: does-not-exist",
		);
	});
});
