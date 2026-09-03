import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Value } from "typebox/value";
import codemarkOrganization, {
	codemarkReadBoundaryViolation,
	codemarkCollaborateParameters,
	prepareCodemarkArguments,
} from "../../codemark/extensions/organization";
import { createInitialOrganization, readInitialOrganization } from "../../codemark/lib/organization";
import codeflowOrganization from "../../runtime/extensions/codeflow-organization";
import { cleanupTmpDirs, makeTmpDir } from "./helpers";

const ENV_KEYS = [
	"CODEFLOW_PROCESS_KIND",
	"CODEFLOW_COMMITMENT_ID",
	"CODEMARK_RUN_ID",
	"CODEMARK_RUN_DIR",
	"CODEMARK_REPOSITORY",
	"CODEMARK_ISSUE",
	"CODEMARK_ISSUE_FILE",
	"CODEMARK_MANAGER_PROVIDER",
	"CODEMARK_MANAGER_MODEL",
	"CODEMARK_MANAGER_THINKING_LEVEL",
	"CODEMARK_MANAGER_PROMPT_PATHS",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
	cleanupTmpDirs();
	for (const key of ENV_KEYS) {
		const value = originalEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function registeredTool(
	extension: (pi: any) => void,
	handlers: Record<string, (...args: any[]) => unknown> = {},
): any {
	let tool: any;
	extension({
		registerTool(candidate: unknown) { tool = candidate; },
		on(event: string, handler: (...args: any[]) => unknown) { handlers[event] = handler; },
	});
	if (!tool) throw new Error("extension did not register collaborate");
	return tool;
}

function body(result: any): any {
	return JSON.parse(result.content[0].text);
}

describe("Codemark collaborate extension", () => {
	test("denies reads of private or process-backed harness state", () => {
		const repository = makeTmpDir("codemark-read-boundary-repository-");
		const runDir = makeTmpDir("codemark-read-boundary-private-");
		const frontier = `${runDir}/frontier.json`;
		fs.writeFileSync(frontier, "private", "utf8");
		const link = `${repository}/frontier-link`;
		fs.symlinkSync(frontier, link);
		fs.symlinkSync(frontier, `${repository}/frontier’s`);
		fs.writeFileSync(`${repository}/README.md`, "public", "utf8");
		process.env.CODEMARK_RUN_DIR = runDir;
		process.env.CODEMARK_REPOSITORY = repository;
		const handlers: Record<string, (...args: any[]) => unknown> = {};
		registeredTool(codemarkOrganization, handlers);

		for (const target of [
			frontier,
			path.relative(repository, frontier),
			pathToFileURL(frontier).href,
			`@${pathToFileURL(frontier).href}`,
			fs.realpathSync(link),
			link,
			"/proc/self/environ",
			"/proc/self/cmdline",
			"/dev/fd/9",
		]) {
			expect(codemarkReadBoundaryViolation(target, repository, repository, runDir)).toBe("read target is unavailable");
			expect(handlers.tool_call?.({
				toolCallId: `read-${target}`,
				toolName: "read",
				input: { path: target },
			})).toEqual({ block: true, reason: "read target is unavailable" });
		}
		expect(codemarkReadBoundaryViolation("README.md", repository, repository, runDir)).toBeNull();
		expect(codemarkReadBoundaryViolation("missing.md", repository, repository, runDir)).toBe("read target is unavailable");
		expect(codemarkReadBoundaryViolation("frontier's", repository, repository, runDir)).toBe("read target is unavailable");
		const allowedInput = { path: `${repository}/README.md` };
		expect(handlers.tool_call?.({
			toolCallId: "read-source",
			toolName: "read",
			input: allowedInput,
		})).toBeUndefined();
		expect(allowedInput.path).toBe(fs.realpathSync(`${repository}/README.md`));
	});

	test("uses Pi-equivalent TypeBox conversion before classifying calls", () => {
		const raw = {
			action: { name: "claim", work: 123, done_when: "frontier frozen" },
		};
		expect(prepareCodemarkArguments(raw)).toEqual({
			action: { name: "claim", work: "123", done_when: ["frontier frozen"] },
		});
		expect(raw).toEqual({
			action: { name: "claim", work: 123, done_when: "frontier frozen" },
		});
		expect(prepareCodemarkArguments({
			action: { name: "wait", execution_id: null },
		})).toEqual({
			action: { name: "wait", execution_id: "null" },
		});
	});

	test("keeps the complete production Manager tool metadata surface", () => {
		process.env.CODEFLOW_PROCESS_KIND = "root";
		const productionTool = registeredTool(codeflowOrganization);
		const codemarkTool = registeredTool(codemarkOrganization);
		const production = productionTool.parameters.properties.action.anyOf as any[];
		const codemark = (codemarkCollaborateParameters as any).properties.action.anyOf as any[];
		expect(codemarkTool.label).toBe(productionTool.label);
		expect(codemarkTool.description).toBe(productionTool.description);
		expect(codemarkTool.parameters).toEqual(productionTool.parameters);
		expect(codemarkTool.executionMode).toBe("sequential");
		expect(codemark.map((entry) => entry.properties.name.const)).toEqual([
			"inspect",
			"claim",
			"report",
			"delegate",
			"wait",
		]);
		for (const candidate of codemark) {
			const name = candidate.properties.name.const;
			const corresponding = production.find((entry) => entry.properties.name.const === name);
			expect(corresponding).toBeDefined();
			expect(Object.keys(candidate.properties)).toEqual(Object.keys(corresponding.properties));
			expect(candidate.required).toEqual(corresponding.required);
		}
		expect(Value.Check(codemarkCollaborateParameters, {
			action: {
				name: "delegate",
				new_goal: { goal_id: "tests", objective: "design regression coverage" },
				focus: "record a proposed Worker",
			},
		})).toBe(true);
	});

	test("terminates an entire same-response claim, delegate, and wait batch", async () => {
		const runDir = makeTmpDir("codemark-extension-batch-");
		createInitialOrganization(runDir, {
			runId: "codemark-extension-batch",
			issue: "Inspect this issue",
			repository: "/workspace/repository",
		});
		process.env.CODEMARK_RUN_ID = "codemark-extension-batch";
		process.env.CODEMARK_RUN_DIR = runDir;
		const handlers: Record<string, (...args: any[]) => unknown> = {};
		const tool = registeredTool(codemarkOrganization, handlers);
		const ctx = { cwd: "/workspace/repository", abort() {}, shutdown() {} };
		handlers.message_end?.({
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "read-before", name: "read", arguments: { path: "README.md" } },
					{ type: "toolCall", id: "claim", name: "collaborate", arguments: { action: { name: "claim", work: "organize the task" } } },
					{ type: "toolCall", id: "delegate", name: "collaborate", arguments: { action: { name: "delegate", goal_id: "codemark-extension-batch", focus: "inspect" } } },
					{ type: "toolCall", id: "wait", name: "collaborate", arguments: { action: { name: "wait" } } },
					{ type: "toolCall", id: "delegate-after", name: "collaborate", arguments: { action: { name: "delegate" } } },
					{ type: "toolCall", id: "wait-after", name: "collaborate", arguments: { action: { name: "wait" } } },
				],
			},
		});
		expect(handlers.tool_call?.({ toolCallId: "read-before", toolName: "read" })).toEqual({
			block: true,
			reason: "tool call superseded by the terminal wait in this batch",
			terminate: true,
		});
		for (const toolCallId of ["delegate-after", "wait-after"]) {
			expect(handlers.tool_call?.({ toolCallId, toolName: "collaborate" })).toEqual({
				block: true,
				reason: "tool call superseded by the terminal wait in this batch",
				terminate: true,
			});
		}

		const claimResult = await tool.execute("claim", {
			action: { name: "claim", work: "organize the task" },
		}, undefined, undefined, ctx);
		const delegateResult = await tool.execute("delegate", {
			action: {
				name: "delegate",
				goal_id: "codemark-extension-batch",
				focus: "inspect the implementation",
			},
		}, undefined, undefined, ctx);
		const waitResult = await tool.execute("wait", {
			action: { name: "wait", execution_id: body(delegateResult).execution_id },
		}, undefined, undefined, ctx);

		expect([claimResult.terminate, delegateResult.terminate, waitResult.terminate]).toEqual([
			true,
			true,
			true,
		]);
	});

	test("an earlier collaborate error cannot prevent a later wait from terminating the batch", async () => {
		const runDir = makeTmpDir("codemark-extension-error-wait-");
		createInitialOrganization(runDir, {
			runId: "codemark-extension-error-wait",
			issue: "Inspect this issue",
			repository: "/workspace/repository",
		});
		process.env.CODEMARK_RUN_ID = "codemark-extension-error-wait";
		process.env.CODEMARK_RUN_DIR = runDir;
		const handlers: Record<string, (...args: any[]) => unknown> = {};
		const tool = registeredTool(codemarkOrganization, handlers);
		const ctx = { cwd: "/workspace/repository", abort() {}, shutdown() {} };
		await tool.execute("initial-claim", {
			action: { name: "claim", work: "organize the task" },
		}, undefined, undefined, ctx);
		handlers.message_end?.({
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "duplicate-claim", name: "collaborate", arguments: { action: { name: "claim", work: "duplicate" } } },
					{ type: "toolCall", id: "wait", name: "collaborate", arguments: { action: { name: "wait" } } },
				],
			},
		});

		const duplicateClaim = await tool.execute("duplicate-claim", {
			action: { name: "claim", work: "duplicate" },
		}, undefined, undefined, ctx);
		const wait = await tool.execute("wait", {
			action: { name: "wait" },
		}, undefined, undefined, ctx);

		expect(body(duplicateClaim)).toMatchObject({ error: expect.any(String) });
		expect([duplicateClaim.terminate, wait.terminate]).toEqual([true, true]);
		expect(readInitialOrganization(runDir)).toMatchObject({
			status: "completed",
			termination: "first_wait",
		});
	});

	test("a zero-Worker first wait completes the measurement and records policy violations", async () => {
		const runDir = makeTmpDir("codemark-extension-invalid-wait-");
		createInitialOrganization(runDir, {
			runId: "codemark-extension-invalid-wait",
			issue: "Inspect this issue",
			repository: "/workspace/repository",
		});
		process.env.CODEMARK_RUN_DIR = runDir;
		const tool = registeredTool(codemarkOrganization);
		let aborts = 0;
		let shutdowns = 0;
		const result = await tool.execute("wait", {
			action: { name: "wait" },
		}, undefined, undefined, {
			cwd: "/workspace/repository",
			abort() { aborts += 1; },
			shutdown() { shutdowns += 1; },
		});

		expect(body(result)).toMatchObject({ status: "completed", termination: "first_wait" });
		expect(result.terminate).toBe(true);
		expect(aborts).toBe(1);
		expect(shutdowns).toBe(1);
		expect(readInitialOrganization(runDir)).toMatchObject({
			status: "completed",
			termination: "first_wait",
			manager_claim: null,
			delegations: [],
			metrics: { delegate_count: 0, initial_worker_count: 0 },
			assessment: {
				organization_valid: false,
				policy_violations: ["manager_claim_missing", "delegation_missing"],
			},
		});
	});

	test("persists proposals and aborts the Manager only after the first wait", async () => {
		const runDir = makeTmpDir("codemark-extension-");
		createInitialOrganization(runDir, {
			runId: "codemark-extension-run",
			issue: "Inspect this issue",
			repository: "/workspace/repository",
			createdAt: "2026-09-04T00:00:00.000Z",
		});
		process.env.CODEMARK_RUN_ID = "codemark-extension-run";
		process.env.CODEMARK_RUN_DIR = runDir;
		delete process.env.CODEFLOW_COMMITMENT_ID;
		const tool = registeredTool(codemarkOrganization);
		let aborts = 0;
		let shutdowns = 0;
		const ctx = {
			cwd: "/workspace/repository",
			abort() { aborts += 1; },
			shutdown() { shutdowns += 1; },
		};
		const execute = (action: Record<string, unknown>) =>
			tool.execute("call", { action }, undefined, undefined, ctx);

		const claimed = body(await execute({ name: "claim", work: "record the initial frontier" }));
		expect(claimed.commitment_id).toMatch(/^c_[0-9a-f]{64}$/);
		expect(process.env.CODEFLOW_COMMITMENT_ID).toBeUndefined();
		expect(aborts).toBe(0);
		expect(shutdowns).toBe(0);

		const delegated = body(await execute({
			name: "delegate",
			goal_id: "codemark-extension-run",
			focus: "inspect the issue",
		}));
		expect(delegated).toMatchObject({ goal_id: "codemark-extension-run", status: "running" });
		expect(delegated.execution_id).toMatch(/^exec_[0-9a-f]{24}$/);
		const producer = body(await execute({
			name: "delegate",
			new_goal: { goal_id: "producer", objective: "produce a prerequisite" },
			focus: "produce the prerequisite",
		}));
		expect(producer.status).toBe("running");
		expect(producer.execution_id).toMatch(/^exec_[0-9a-f]{24}$/);
		const waiting = body(await execute({
			name: "delegate",
			new_goal: {
				goal_id: "consumer",
				objective: "consume the prerequisite",
				dependencies: ["producer"],
			},
			focus: "wait for the prerequisite",
		}));
		expect(waiting).toEqual({ goal_id: "consumer", status: "waiting", execution_id: null });
		expect(aborts).toBe(0);
		expect(shutdowns).toBe(0);

		const waitResult = await execute({ name: "wait", execution_id: delegated.execution_id });
		const waited = body(waitResult);
		expect(waited).toMatchObject({ status: "completed", termination: "first_wait" });
		expect(waitResult.terminate).toBe(true);
		expect(aborts).toBe(1);
		expect(shutdowns).toBe(1);
		expect(readInitialOrganization(runDir)).toMatchObject({
			status: "completed",
			termination: "first_wait",
			metrics: {
				delegate_count: 3,
				initial_worker_count: 2,
				additional_initial_workers: 1,
				ready_now_worker_count: 2,
				waiting_on_dependencies_count: 1,
			},
		});
	});

	test("terminal report still fails without creating canonical protocol objects", async () => {
		const runDir = makeTmpDir("codemark-extension-report-");
		process.env.CODEMARK_RUN_DIR = runDir;
		process.env.CODEMARK_RUN_ID = "codemark-report-run";
		process.env.CODEMARK_ISSUE = "Inspect this issue";
		delete process.env.CODEMARK_ISSUE_FILE;
		const tool = registeredTool(codemarkOrganization);
		const ctx = { cwd: "/workspace/repository", abort() {}, shutdown() {} };
		await tool.execute("claim", { action: { name: "claim", work: "plan only" } }, undefined, undefined, ctx);
		await expect(tool.execute("report", {
			action: { name: "report", status: "completed", summary: "not allowed" },
		}, undefined, undefined, ctx)).rejects.toThrow(/terminal Root Receipt requires at least one Child Worker Commitment/i);
		expect(readInitialOrganization(runDir)).toMatchObject({ status: "running", termination: null });
		expect(fs.existsSync(`${runDir}/receipts`)).toBe(false);
		expect(fs.existsSync(`${runDir}/commitments`)).toBe(false);
	});
});
