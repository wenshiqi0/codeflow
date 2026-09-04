import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	CodemarkError,
	DEFAULT_TIMEOUT_SECONDS,
	VERSION,
	buildManagerInput,
	buildUsageReport,
	firstTurnEndWins,
	parseArguments,
	resolveOutputDir,
} from "../../codemark/cli/run";
import { baseEnv, cleanupTmpDirs, makeTmpDir, runCodemark } from "./helpers";

afterEach(cleanupTmpDirs);

describe("Codemark CLI arguments", () => {
	test("parses the Issue with cheap bounded defaults", () => {
		expect(parseArguments(["repair", "the", "parser"])).toEqual({
			issue: "repair the parser",
			timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
			help: false,
			version: false,
		});
	});

	test("accepts separated and equals option forms", () => {
		expect(parseArguments([
			"--manager-model", "provider/manager",
			"--out=.codemark/runs/case-a",
			"--timeout", "17",
			"inspect this issue",
		])).toMatchObject({
			issue: "inspect this issue",
			managerModel: "provider/manager",
			outDir: ".codemark/runs/case-a",
			timeoutSeconds: 17,
		});
		expect(parseArguments([
			"--manager-model=provider/other",
			"--out", "/tmp/codemark-exact",
			"--timeout=23",
			"another issue",
		])).toMatchObject({
			managerModel: "provider/other",
			outDir: "/tmp/codemark-exact",
			timeoutSeconds: 23,
		});
	});

	test("reserves no positional argument for stdin and exposes metadata flags", () => {
		expect(parseArguments([]).issue).toBeUndefined();
		expect(parseArguments(["--", "--issue-text"])).toMatchObject({ issue: "--issue-text" });
		expect(parseArguments(["--help"])).toMatchObject({ help: true, version: false });
		expect(parseArguments(["--version"])).toMatchObject({ help: false, version: true });
		expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test("rejects ambiguous or malformed input without starting a run", () => {
		const invalid: Array<[string[], RegExp]> = [
			[["--unknown", "issue"], /unknown option.*--unknown/i],
			[["--timeout", "0", "issue"], /timeout.*positive integer/i],
			[["--timeout=-1", "issue"], /timeout.*positive integer/i],
			[["--timeout", "1.5", "issue"], /timeout.*positive integer/i],
			[["--out", "a", "--out", "b", "issue"], /--out.*only once/i],
		];
		for (const [args, message] of invalid) {
			expect(() => parseArguments(args)).toThrow(message);
			try {
				parseArguments(args);
			} catch (error) {
				expect(error).toBeInstanceOf(CodemarkError);
			}
		}
	});

	test("keeps the default output outside the measured repository", () => {
		const repository = makeTmpDir("codemark-output-repository-");
		const externalHome = makeTmpDir("codemark-output-home-");
		expect(resolveOutputDir(undefined, "task-1", repository, externalHome)).toBe(
			path.join(externalHome, "codemark", "runs", "task-1"),
		);
		expect(resolveOutputDir("reports/task-1", "task-1", repository, externalHome)).toBe(
			path.join(repository, "reports", "task-1"),
		);
		expect(() => resolveOutputDir(undefined, "task-1", repository, ".")).toThrow(
			/default output directory resolves inside the repository/i,
		);
		const links = makeTmpDir("codemark-output-links-");
		const linkedHome = path.join(links, "home");
		fs.symlinkSync(repository, linkedHome);
		expect(() => resolveOutputDir(undefined, "task-1", repository, linkedHome)).toThrow(
			/default output directory resolves inside the repository/i,
		);
	});
});

describe("standalone codemark wrapper", () => {
	test("help and version are credential-free and do not create artifacts", () => {
		const cwd = makeTmpDir("codemark-wrapper-");
		const codeflowHome = makeTmpDir("codemark-home-");
		const env = { ...baseEnv(), CODEFLOW_HOME: codeflowHome };
		const help = runCodemark(["--help"], { cwd, env });
		expect(help.exitCode).toBe(0);
		expect(help.stdout).toContain("usage: codemark");
		expect(help.stdout).toContain("--manager-model <provider/model>");
		expect(help.stdout).toContain("--timeout <seconds>");
		expect(help.stdout).toMatch(/No Worker is started/i);

		const version = runCodemark(["--version"], { cwd, env });
		expect(version.exitCode).toBe(0);
		expect(version.stdout.trim()).toBe(`codemark ${VERSION}`);
		expect(fs.existsSync(`${cwd}/.codemark`)).toBe(false);
	});

	test("unknown options and empty stdin fail before any provider call", () => {
		const cwd = makeTmpDir("codemark-invalid-");
		const env = { ...baseEnv(), CODEFLOW_HOME: makeTmpDir("codemark-home-") };
		const unknown = runCodemark(["--definitely-not-real"], { cwd, env });
		expect(unknown.exitCode).toBe(1);
		expect(unknown.stderr).toMatch(/unknown option/i);

		const empty = runCodemark([], { cwd, env, stdin: "\n" });
		expect(empty.exitCode).toBe(1);
		expect(empty.stderr).toMatch(/Issue|stdin/i);

		const nested = runCodemark(["Do not start a nested benchmark"], {
			cwd,
			env: { ...env, CODEFLOW_RUN_ID: "task-parent" },
		});
		expect(nested.exitCode).toBe(1);
		expect(nested.stderr).toMatch(/cannot start inside a Codeflow Task/i);
		expect(fs.existsSync(`${cwd}/.codemark`)).toBe(false);
	});
});

describe("Codemark Manager input and usage", () => {
	test("uses a deterministic durable-turn-end tie rule at the cutoff boundary", () => {
		const at = Date.parse("2026-09-04T00:00:00.123Z");
		expect(firstTurnEndWins("first_turn_end", "2026-09-04T00:00:00.123Z", at)).toBe(true);
		expect(firstTurnEndWins("first_turn_end", "2026-09-04T00:00:00.124Z", at)).toBe(false);
		expect(firstTurnEndWins("manager_exit", "2026-09-04T00:00:00.122Z", at)).toBe(false);
		expect(firstTurnEndWins("first_turn_end", null, null)).toBe(false);
		expect(firstTurnEndWins("first_turn_end", "not-a-timestamp", at)).toBe(false);
		expect(firstTurnEndWins("first_turn_end", "not-a-timestamp", null)).toBe(false);
		expect(firstTurnEndWins("first_turn_end", "2026-09-04T00:00:00.122Z", null)).toBe(true);
	});

	test("uses exactly the production fresh-Root instruction", () => {
		const input = buildManagerInput();
		expect(input).toBe("Inspect the Task and organize the work needed to close it.");
		expect(input).not.toMatch(/codeflow_context|first natural turn end|does not start|initial organization|measurement/i);
	});

	test("aggregates exact usage by response model and in total", () => {
		const baseUsage = {
			input: 10,
			output: 4,
			cache_read: 3,
			cache_write: 2,
			reasoning: 1,
			total_tokens: 20,
			cost: { input: 0.1, output: 0.2, cache_read: 0.03, cache_write: 0.02, total: 0.35 },
		};
		const records: any[] = [
			{
				schema_version: 1,
				at: T0,
				run_id: "codemark-usage-run",
				process_kind: "manager",
				turn: 1,
				provider: "z-provider",
				model: "m2",
				response_model: "m2",
				usage: baseUsage,
			},
			{
				schema_version: 1,
				at: T0,
				run_id: "codemark-usage-run",
				process_kind: "manager",
				turn: 2,
				provider: "a-provider",
				model: "m1",
				response_model: "m1",
				usage: { ...baseUsage, input: 7, total_tokens: 17 },
			},
		];
		const report = buildUsageReport("codemark-usage-run", records);
		expect(report.models.map((model) => model.model)).toEqual(["a-provider/m1", "z-provider/m2"]);
		expect(report.total).toEqual({
			calls: 2,
			input: 17,
			output: 8,
			cache_read: 6,
			cache_write: 4,
			reasoning: 2,
			total_tokens: 37,
			cost: { input: 0.2, output: 0.4, cache_read: 0.06, cache_write: 0.04, total: 0.7 },
		});
	});
});

const T0 = "2026-09-04T00:00:00.000Z";
