import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import organization from "../../runtime/extensions/codeflow-organization";
import protocol from "../../runtime/extensions/codeflow-protocol";
import { buildChildWorkerArgs } from "../../runtime/extensions/codeflow-organization/worker-launcher";
import { buildWorkerContext } from "../../runtime/extensions/codeflow-context/context";
import { buildWorkerArgv, type ResolvedExecutor } from "../../runtime/lib/config";
import { createGoal } from "../../runtime/lib/goals";
import { openHandoff, submitReceipt } from "../../runtime/lib/handoff";
import { RunPaths } from "../../runtime/lib/paths";
import { createTask } from "../../runtime/lib/tasks";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function runtime(): RunPaths {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-context-"));
	dirs.push(root);
	return new RunPaths(path.join(root, "runs"), "task-context");
}

describe("cache-aware Goal context", () => {
	test("Root semantic history precedes local history and mutable state", () => {
		const paths = runtime();
		createTask(paths, "Build outcome");
		const root = openHandoff(paths, { goalId: paths.runId, digest: "root scope", intent: "scope", expectedOutcome: ["known"] });
		submitReceipt(paths, { handoffId: root.id, status: "completed", established: ["root established"] });
		createGoal(paths, { id: "child", objective: "Child outcome" });
		const prior = openHandoff(paths, { goalId: "child", digest: "prior child", intent: "prior", expectedOutcome: ["prior done"] });
		submitReceipt(paths, { handoffId: prior.id, status: "completed", established: ["child established"] });
		const current = openHandoff(paths, { goalId: "child", digest: "current child", intent: "continue", expectedOutcome: ["finished"] });
		const built = buildWorkerContext(paths, current);
		const rootAt = built.xml.indexOf("root established");
		const localAt = built.xml.indexOf("child established");
		const stateAt = built.xml.indexOf("<goal_state>");
		const currentAt = built.xml.indexOf("<current_handoff>");
		expect(rootAt).toBeGreaterThan(-1);
		expect(rootAt).toBeLessThan(localAt);
		expect(localAt).toBeLessThan(stateAt);
		expect(stateAt).toBeLessThan(currentAt);
	});
});

describe("capability is the loaded tool surface", () => {
	test("protocol is universal and organization is a separate Root extension", () => {
		const universal: string[] = [];
		const rootOnly: string[] = [];
		protocol({ registerTool(tool: { name: string }) { universal.push(tool.name); } } as never);
		organization({ registerTool(tool: { name: string }) { rootOnly.push(tool.name); } } as never);
		expect(universal.sort()).toEqual(["recall", "receipt"]);
		expect(rootOnly.sort()).toEqual(["goal_create", "goal_dependencies", "handoff_create", "handoff_spawn", "worker_group", "worker_spawn"]);
	});

	test("every Worker launch is a fresh Pi context with extension discovery disabled", () => {
		const launcher = fs.readFileSync(path.resolve(import.meta.dir, "../../runtime/extensions/codeflow-organization/worker-launcher.ts"), "utf8");
		const resolved: ResolvedExecutor = {
			provider: "test-provider",
			model: "test-model",
			systemPrompt: "test system prompt",
			promptPath: "/tmp/worker.md",
		};
		const rootArgs = buildWorkerArgv(resolved, "root prompt", ["/runtime/extensions/root-only.ts"]);
		const childArgs = buildChildWorkerArgs(resolved);
		expect(rootArgs).toContain("--no-extensions");
		expect(childArgs).toContain("--no-extensions");
		expect(rootArgs).toContain("/runtime/extensions/root-only.ts");
		const childExtensions = childArgs.flatMap((arg, index) =>
			arg === "--extension" ? [path.basename(path.dirname(childArgs[index + 1]))] : [],
		);
		expect(childExtensions).toEqual([
			"provider-profiles",
			"codeflow-protocol",
			"host-guard",
			"codeflow-context",
			"bash-compressor",
			"usage-ledger",
			"telemetry-ledger",
			"agent-watchdog",
		]);
		expect(launcher).toContain("buildChildWorkerArgs(resolved)");
		expect(launcher).not.toContain('"--no-session"');
		expect(rootArgs).not.toContain("--no-session");
		expect(childArgs).not.toContain("--no-session");
		expect(launcher).not.toContain("--session-id");
	});
});
