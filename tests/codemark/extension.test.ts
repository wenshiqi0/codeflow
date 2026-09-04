import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Value } from "typebox/value";
import codemarkOrganization, {
	codemarkReadBoundaryViolation,
	codemarkCollaborateParameters,
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

	test("records all proposals until natural agent_end without aborting or terminating tools", async () => {
		const runDir = makeTmpDir("codemark-extension-turn-");
		createInitialOrganization(runDir, { runId: "codemark-turn", issue: "Inspect", repository: "/workspace/repository" });
		process.env.CODEMARK_RUN_DIR = runDir;
		const handlers: Record<string, (...args: any[]) => unknown> = {};
		const tool = registeredTool(codemarkOrganization, handlers);
		let aborts = 0;
		let shutdowns = 0;
		const ctx = { cwd: "/workspace/repository", abort() { aborts++; }, shutdown() { shutdowns++; } };
		const claim = await tool.execute("claim", { action: { name: "claim", work: "organize work" } }, undefined, undefined, ctx);
		for (const id of ["developer", "tester"]) {
			const delegated = await tool.execute(id, { action: { name: "delegate", goal_id: "codemark-turn", focus: id } }, undefined, undefined, ctx);
			expect(delegated.terminate).toBeUndefined();
		}
		expect(claim.terminate).toBeUndefined();
		expect(readInitialOrganization(runDir).status).toBe("running");
		expect(handlers.message_end).toBeUndefined();
		expect(handlers.turn_end).toBeUndefined();
		handlers.agent_end?.({ messages: [
			{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall" }] },
			{ role: "toolResult", content: [] },
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Initial work organized." }] },
		] }, ctx);
		expect(readInitialOrganization(runDir)).toMatchObject({
			status: "completed", termination: "first_turn_end",
			metrics: { delegate_count: 2, initial_worker_count: 2 },
			assessment: { organization_valid: true, policy_violations: [] },
		});
		const frozen = fs.readFileSync(path.join(runDir, "frontier.json"), "utf8");
		handlers.agent_end?.({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, ctx);
		expect(fs.readFileSync(path.join(runDir, "frontier.json"), "utf8")).toBe(frozen);
		await expect(tool.execute("late-delegate", { action: { name: "delegate", goal_id: "codemark-turn", focus: "late" } }, undefined, undefined, ctx)).rejects.toThrow(/unavailable after Codemark terminated/);
		expect([aborts, shutdowns]).toEqual([0, 0]);
		expect("wait" in readInitialOrganization(runDir)).toBe(false);
	});

	test("zero-Worker natural turn end is measured successfully with policy violations", () => {
		const runDir = makeTmpDir("codemark-extension-zero-");
		createInitialOrganization(runDir, { runId: "codemark-zero", issue: "Inspect", repository: "/workspace/repository" });
		process.env.CODEMARK_RUN_DIR = runDir;
		const handlers: Record<string, (...args: any[]) => unknown> = {};
		registeredTool(codemarkOrganization, handlers);
		handlers.agent_end?.({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, { cwd: "/workspace/repository" });
		expect(readInitialOrganization(runDir)).toMatchObject({
			status: "completed", termination: "first_turn_end",
			assessment: { organization_valid: false, policy_violations: ["manager_claim_missing", "delegation_missing"] },
		});
	});

	for (const messages of [
		[],
		[{ role: "user", content: "issue" }],
		[{ role: "assistant", stopReason: "error", content: [] }],
		[{ role: "assistant", stopReason: "length", content: [] }],
		[{ role: "assistant", stopReason: "aborted", content: [] }],
		[{ role: "assistant", stopReason: "stop", errorMessage: "provider failed", content: [] }],
		[{ role: "assistant", stopReason: "stop", content: [{ type: "toolCall" }] }],
		[{ role: "assistant", stopReason: "length", content: [] }, { role: "assistant", stopReason: "stop", content: [] }],
	]) {
		test(`does not mark abnormal agent_end as successful: ${JSON.stringify(messages)}`, () => {
			const runDir = makeTmpDir("codemark-extension-abnormal-");
			createInitialOrganization(runDir, { runId: "codemark-abnormal", issue: "Inspect", repository: "/workspace/repository" });
			process.env.CODEMARK_RUN_DIR = runDir;
			const handlers: Record<string, (...args: any[]) => unknown> = {};
			registeredTool(codemarkOrganization, handlers);
			handlers.agent_end?.({ messages }, { cwd: "/workspace/repository" });
			expect(readInitialOrganization(runDir)).toMatchObject({ status: "running", termination: null });
			if (messages.some((message) => ["error", "aborted", "length"].includes(message.stopReason ?? "") || "errorMessage" in message)) {
				handlers.agent_end?.({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, { cwd: "/workspace/repository" });
				expect(readInitialOrganization(runDir)).toMatchObject({ status: "running", termination: null });
			}
		});
	}

	test("deleted actions are rejected without a compatibility path", async () => {
		const runDir = makeTmpDir("codemark-extension-removed-");
		createInitialOrganization(runDir, { runId: "codemark-removed", issue: "Inspect", repository: "/workspace/repository" });
		process.env.CODEMARK_RUN_DIR = runDir;
		const tool = registeredTool(codemarkOrganization);
		const params = { action: { name: "wait" } };
		expect(Value.Check(codemarkCollaborateParameters, params)).toBe(false);
		await expect(tool.execute("removed", params, undefined, undefined, { cwd: "/workspace/repository" })).rejects.toThrow(/unknown collaborate action/);
		expect(readInitialOrganization(runDir).status).toBe("running");
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
