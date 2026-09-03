import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import codemarkContext from "../../codemark/extensions/context";
import { createInitialOrganization } from "../../codemark/lib/organization";
import {
	buildFreshRootContext,
	buildWorkerContext,
} from "../../runtime/extensions/codeflow-context/context";
import { RunPaths } from "../../runtime/lib/paths";
import { createTask } from "../../runtime/lib/tasks";
import { cleanupTmpDirs, makeTmpDir } from "./helpers";

const originalRunDir = process.env.CODEMARK_RUN_DIR;

afterEach(() => {
	cleanupTmpDirs();
	if (originalRunDir === undefined) delete process.env.CODEMARK_RUN_DIR;
	else process.env.CODEMARK_RUN_DIR = originalRunDir;
});

describe("Codemark fresh Root context", () => {
	test("is byte-for-byte equal to the production fresh Root projection", () => {
		const root = makeTmpDir("codemark-context-production-");
		const paths = new RunPaths(path.join(root, "runs", "code"), "task-context-parity");
		const issue = `${"a".repeat(400)}<middle>${"z".repeat(400)}`;
		const projectRules = "Keep A < B & do not leak > context.\n";
		createTask(paths, issue);

		const production = buildWorkerContext(paths, paths.runId, null, { projectRules });
		const benchmark = buildFreshRootContext(paths.runId, issue, { projectRules });
		expect(benchmark).toEqual(production);
		expect(benchmark.xml).toContain("<project_rules>");
		expect(benchmark.xml).toContain("<goal>");
		expect(benchmark.xml).toContain("<worker_bootstrap>");
		expect(benchmark.xml).toContain("…");
		expect(benchmark.xml).not.toContain(issue);
	});

	test("injects the production projection as the same custom message", () => {
		const repository = makeTmpDir("codemark-context-repository-");
		const runDir = makeTmpDir("codemark-context-run-");
		const issue = "Split diagnosis from regression coverage";
		const projectRules = "Inspect before editing.\n";
		fs.writeFileSync(path.join(repository, "AGENTS.md"), projectRules, "utf8");
		createInitialOrganization(runDir, {
			runId: "task-context-extension",
			issue,
			repository,
		});
		process.env.CODEMARK_RUN_DIR = runDir;
		const handlers: Record<string, (...args: any[]) => any> = {};
		codemarkContext({
			on(event: string, handler: (...args: any[]) => any) { handlers[event] = handler; },
		} as any);

		const eventResult = handlers.before_agent_start({
			systemPromptOptions: { cwd: repository },
		});
		const expected = buildFreshRootContext("task-context-extension", issue, { projectRules });
		expect(eventResult).toEqual({
			message: {
				customType: "codeflow:context",
				content: expected.xml,
				display: true,
				details: { sources: expected.sources, shape: expected.shape },
			},
		});
	});

	test("does not inject project rules whose canonical file is outside the repository", () => {
		const repository = makeTmpDir("codemark-context-boundary-repository-");
		const runDir = makeTmpDir("codemark-context-boundary-run-");
		const outside = makeTmpDir("codemark-context-boundary-outside-");
		const secret = "OUTSIDE_PROJECT_RULES_CANARY";
		fs.writeFileSync(path.join(outside, "secret.md"), secret, "utf8");
		fs.symlinkSync(path.join(outside, "secret.md"), path.join(repository, "AGENTS.md"));
		createInitialOrganization(runDir, {
			runId: "task-context-boundary",
			issue: "Inspect the repository only",
			repository,
		});
		process.env.CODEMARK_RUN_DIR = runDir;
		const handlers: Record<string, (...args: any[]) => any> = {};
		codemarkContext({
			on(event: string, handler: (...args: any[]) => any) { handlers[event] = handler; },
		} as any);

		const eventResult = handlers.before_agent_start({ systemPromptOptions: { cwd: repository } });
		const expected = buildFreshRootContext(
			"task-context-boundary",
			"Inspect the repository only",
			{ projectRules: "" },
		);
		expect(eventResult.message.content).toBe(expected.xml);
		expect(eventResult.message.content).not.toContain(secret);
	});
});
