import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import organization from "../../runtime/extensions/codeflow-organization";
import { buildChildWorkerArgs, resolveLaunchWorker } from "../../runtime/extensions/codeflow-organization/worker-launcher";
import { buildWorkerContext, truncateContextText } from "../../runtime/extensions/codeflow-context/context";
import { buildAgentArgv, loadRuntimeConfig, resolveAgent, type ResolvedExecutor } from "../../runtime/lib/config";
import { AGENT_TOOL_ALLOWLIST, agentExtensions } from "../../runtime/lib/agent-launch";
import { createGoal } from "../../runtime/lib/goals";
import { loadReceiptChain, submitReceipt } from "../../runtime/lib/commitment";
import { claimTestWork } from "./helpers";
import { RunPaths } from "../../runtime/lib/paths";
import { createTask } from "../../runtime/lib/tasks";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function runtime(): RunPaths {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-context-"));
	dirs.push(root);
	return new RunPaths(path.join(root, "runs"), "task-context");
}

describe("pull-first Goal context", () => {
	test("injects bounded Goal history with ids before the current Commitment", () => {
		const paths = runtime();
		createTask(paths, "Build outcome");
		const root = claimTestWork(paths, { goalId: paths.runId, work: "root scope" });
		submitReceipt(paths, { commitmentId: root.id, status: "completed", summary: "root established" });
		createGoal(paths, { id: "child", objective: "Child outcome" });
		const prior = claimTestWork(paths, { goalId: "child", work: "prior child" });
		submitReceipt(paths, { commitmentId: prior.id, status: "completed", summary: "child established" });
		const current = claimTestWork(paths, { goalId: "child", work: "current child" });
		const built = buildWorkerContext(paths, "child", current);
		const kinds = built.sources.map((entry) => entry.kind);
		expect(kinds).toEqual(["root_goal", "goal", "commit", "receipt", "current_commitment", "current_commitment_folded"]);
		expect(built.xml).not.toContain("context_manifest");
		expect(built.xml).not.toContain("\"runnable\"");
		expect(built.shape.chars).toBe(built.xml.length);
		expect(built.shape.sections.map((section) => section.kind)).toEqual(kinds);
		expect(built.xml).toContain(`<commit id="${prior.id}">prior child</commit>`);
		expect(built.xml).toContain(`<receipt id="${loadReceiptChain(paths, prior.id).head!.id}">child established</receipt>`);
		expect(built.xml).not.toContain("root scope");
		expect(built.xml).toContain("child established");
		expect(built.xml.match(/child established/g)).toHaveLength(1);
		expect(built.xml).toContain("<current_commitment_folded>");
		expect(built.xml.indexOf(`<commit id="${prior.id}">`)).toBeLessThan(
			built.xml.indexOf(`<receipt id="${loadReceiptChain(paths, prior.id).head!.id}">`),
		);
	});

	test("truncates every long model-visible string to its first and last 300 characters", () => {
		const paths = runtime();
		const long = `${"a".repeat(350)}${"b".repeat(350)}`;
		createTask(paths, long);
		const prior = claimTestWork(paths, { goalId: paths.runId, work: long });
		const receipt = submitReceipt(paths, { commitmentId: prior.id, status: "completed", summary: long });
		const built = buildWorkerContext(paths, paths.runId, null, { projectRules: long, workFocus: long });
		const bounded = `${"a".repeat(300)}…${"b".repeat(300)}`;
		expect(truncateContextText(long)).toBe(bounded);
		expect([...truncateContextText(long)]).toHaveLength(601);
		expect(built.xml).not.toContain(long);
		expect(built.xml).toContain(`<commit id="${prior.id}">${bounded}</commit>`);
		expect(built.xml).toContain(`<receipt id="${receipt.id}">${bounded}</receipt>`);
		expect(built.xml).toContain(`\"objective\":\"${bounded}\"`);
		expect(built.xml).toContain(`<project_rules>${bounded}</project_rules>`);
		expect(built.xml).toContain(`\"focus\":\"${bounded}\"`);
	});

	test("a fresh Commitment carries an empty folded state and null head", () => {
		const paths = runtime();
		createTask(paths, "Build outcome");
		const current = claimTestWork(paths, { goalId: paths.runId, work: "root" });
		const built = buildWorkerContext(paths, paths.runId, current);
		expect(built.xml).toContain("\"receipt_id\":null");
		expect(built.xml).toContain("\"terminal\":false");
		expect(built.xml.match(/Build outcome/g)).toHaveLength(1);
	});
});

describe("capability is the loaded tool surface", () => {
	test("one collaborate tool exposes unified capabilities", () => {
		const tools: string[] = [];
		process.env.CODEFLOW_PROCESS_KIND = "worker";
		organization({ on() {}, registerTool(tool: { name: string }) { tools.push(tool.name); } } as never);
		expect(tools).toEqual(["collaborate"]);
		delete process.env.CODEFLOW_PROCESS_KIND;
	});

	test("every Agent launch has identical tools and extensions in a fresh Pi context", () => {
		const launcher = fs.readFileSync(path.resolve(import.meta.dir, "../../runtime/extensions/codeflow-organization/worker-launcher.ts"), "utf8");
		const resolved: ResolvedExecutor = {
			provider: "test-provider",
			model: "test-model",
			systemPrompts: ["shared system prompt", "scoped method knowledge"],
			promptPaths: ["/tmp/worker.md", "/tmp/methods.md"],
		};
		const runtimeDir = path.resolve(import.meta.dir, "../../runtime");
		const rootArgs = buildAgentArgv(
			resolved,
			"root prompt",
			agentExtensions(runtimeDir),
			AGENT_TOOL_ALLOWLIST,
		);
		const childArgs = buildChildWorkerArgs(resolved);
		expect(rootArgs).toContain("--no-extensions");
		expect(childArgs).toContain("--no-extensions");
		const appended = (args: string[]) => args.flatMap((arg, index) =>
			arg === "--append-system-prompt" ? [args[index + 1]] : []);
		expect(appended(rootArgs)).toEqual(resolved.systemPrompts);
		expect(appended(childArgs)).toEqual(resolved.systemPrompts);
		expect(rootArgs).not.toContain("--system-prompt");
		expect(childArgs).not.toContain("--system-prompt");
		expect(rootArgs.slice(rootArgs.indexOf("--tools"), rootArgs.indexOf("--tools") + 2))
			.toEqual(["--tools", "read,write,edit,bash,collaborate"]);
		expect(childArgs.slice(childArgs.indexOf("--tools"), childArgs.indexOf("--tools") + 2))
			.toEqual(["--tools", AGENT_TOOL_ALLOWLIST.join(",")]);
		expect(rootArgs.filter((arg, index) => rootArgs[index - 1] === "--extension"))
			.toEqual(childArgs.filter((arg, index) => childArgs[index - 1] === "--extension"));
		const childExtensions = childArgs.flatMap((arg, index) =>
			arg === "--extension" ? [path.basename(path.dirname(childArgs[index + 1]))] : [],
		);
		expect(childExtensions).toEqual([
			"provider-profiles",
			"codeflow-organization",
			"host-guard",
			"codeflow-context",
			"bash-compressor",
			"usage-ledger",
			"telemetry-ledger",
			"agent-watchdog",
		]);
		expect(launcher).toContain("buildChildWorkerArgs(resolved, input.resumeCommitmentId !== undefined)");
		expect(launcher).not.toContain('"--no-session"');
		expect(rootArgs).not.toContain("--no-session");
		expect(childArgs).not.toContain("--no-session");
		expect(launcher).not.toContain("--session-id");
	});

	test("all Agent generations use the same formal prompt and model", () => {
		const config = path.resolve(import.meta.dir, "../../runtime/config.json");
		const agent = resolveAgent(config);
		const child = resolveLaunchWorker();
		expect(agent.promptPaths.map((prompt) => path.basename(prompt))).toEqual(["agent.md"]);
		expect(child).toEqual(agent);
		expect({ provider: agent.provider, model: agent.model }).toEqual({
			provider: "zhipuai-coding-plan",
			model: "glm-5.3",
		});
		expect(agent.thinkingLevel).toBe("high");
		expect(agent.systemPrompts.join("\n")).toContain("# Agent");
		expect(agent.systemPrompts.join("\n")).toContain("Test-driven development");
	});

	test("the retired split role shape is rejected instead of treated as compatibility input", () => {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-config-"));
		dirs.push(temp);
		const config = path.join(temp, "config.json");
		fs.writeFileSync(config, JSON.stringify({
			agents: {
				manager: { model: "provider/model", prompt: "references/manager.md" },
				worker: { model: "provider/model", prompt: "references/worker.md" },
			},
			services: {
				output_compression: { model: "provider/model", prompt: "references/output-compression.md" },
			},
		}));
		expect(() => loadRuntimeConfig(config)).toThrow("runtime config contains unknown keys");
	});

	test("spawned Agents inherit the run-scoped model override", () => {
		const resolved = resolveLaunchWorker("explicit-provider/explicit-model");
		expect({ provider: resolved.provider, model: resolved.model }).toEqual({
			provider: "explicit-provider",
			model: "explicit-model",
		});
	});

	test("the default GLM Agent uses its highest supported thinking level", () => {
		const resolved = resolveLaunchWorker();
		expect({ provider: resolved.provider, model: resolved.model }).toEqual({
			provider: "zhipuai-coding-plan",
			model: "glm-5.3",
		});
		const args = buildChildWorkerArgs(resolved);
		expect(resolved.thinkingLevel).toBe("high");
		expect(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2)).toEqual(["--thinking", "high"]);
	});
});
