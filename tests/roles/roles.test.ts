/** Contract tests for the structured role registry and Pi invocation. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ALLOWED_KEYS,
	buildArgv,
	listRoles,
	readRoleDefinition,
	resolveRole,
	RoleError,
} from "../../runtime/lib/roles";
import { newRunId } from "../../runtime/cli/run";

let root: string;
let registryFile: string;

function writeRegistry(roles: Record<string, Record<string, unknown>>): void {
	fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
	fs.writeFileSync(registryFile, JSON.stringify({ roles }), "utf-8");
}

function writePrompt(name: string, body = "Do the thing carefully.\n"): string {
	const relative = `references/capabilities/${name}.md`;
	const file = path.join(root, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body, "utf-8");
	return relative;
}

function role(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		description: `${name} capability`,
		model: "kimi/k3",
		prompt: writePrompt(name),
		...extra,
	};
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-roles-"));
	registryFile = path.join(root, "runtime", "roles.json");
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("registry", () => {
	test("lists roles alphabetically", () => {
		writeRegistry({ planner: role("planner"), coder: role("coder") });
		expect(listRoles(registryFile)).toEqual(["coder", "planner"]);
	});

	test("a missing registry yields no roles", () => {
		expect(listRoles(registryFile)).toEqual([]);
	});

	test("reads a definition without mixing it with prompt text", () => {
		writeRegistry({ planner: role("planner", { delegates: true }) });
		expect(readRoleDefinition(registryFile, "planner")).toMatchObject({
			model: "kimi/k3",
			delegates: true,
		});
		expect(readRoleDefinition(registryFile, "ghost")).toBeNull();
	});

	test("rejects unknown configuration fields", () => {
		writeRegistry({ coder: role("coder", { mystery: true }) });
		expect(() => resolveRole(registryFile, "coder")).toThrow(RoleError);
	});
});

describe("resolution", () => {
	test("splits provider/model and loads the canonical prompt body", () => {
		const prompt = writePrompt("coder", "Canonical coder prompt.\n");
		writeRegistry({ coder: { description: "codes", model: "kimi/k3", prompt } });
		const resolved = resolveRole(registryFile, "coder")!;
		expect(resolved.provider).toBe("kimi");
		expect(resolved.model).toBe("k3");
		expect(resolved.systemPrompt).toBe("Canonical coder prompt.\n");
		expect(resolved.promptPath).toBe(fs.realpathSync(path.join(root, prompt)));
	});

	test("an unknown role resolves to null", () => {
		writeRegistry({});
		expect(resolveRole(registryFile, "ghost")).toBeNull();
	});

	test("rejects malformed or missing model bindings", () => {
		writeRegistry({ coder: role("coder", { model: "k3" }) });
		expect(() => resolveRole(registryFile, "coder")).toThrow("model must be '<provider>/<model>'");
		writeRegistry({ coder: { description: "codes", prompt: writePrompt("coder") } });
		expect(() => resolveRole(registryFile, "coder")).toThrow("model must be a non-empty string");
	});

	test("rejects prompts outside references and missing prompts", () => {
		fs.writeFileSync(path.join(root, "outside.md"), "outside", "utf-8");
		writeRegistry({ coder: role("coder", { prompt: "outside.md" }) });
		expect(() => resolveRole(registryFile, "coder")).toThrow("prompt must be Markdown below references/");
		writeRegistry({ coder: role("coder", { prompt: "references/capabilities/missing.md" }) });
		expect(() => resolveRole(registryFile, "coder")).toThrow("prompt is unreadable");
	});

	test("validates tools, lanes, and context policy", () => {
		writeRegistry({ coder: role("coder", { tools: "read,bash" }) });
		expect(() => resolveRole(registryFile, "coder")).toThrow("tools must be an array");
		writeRegistry({ coder: role("coder", { goal_lane: "product" }) });
		expect(() => resolveRole(registryFile, "coder")).toThrow("goal_lane must be test, code, or verify");
		writeRegistry({ coder: role("coder", { needs_project_rules: "sometimes" }) });
		expect(() => resolveRole(registryFile, "coder")).toThrow("needs_project_rules must be false, shared, or full");
	});

	test("production registry keeps the intended role policies", () => {
		const production = path.resolve(import.meta.dir, "../../runtime/roles.json");
		const expectedTools = new Map<string, string[] | undefined>([
			["architect", undefined],
			["coder", undefined],
			["planner", ["read", "write", "bash", "goal", "task", "task_group"]],
			["supervisor", ["read", "write", "bash"]],
			["verify", undefined],
			["tester", undefined],
			["zipper", undefined],
		]);
		for (const name of listRoles(production)) {
			expect(expectedTools.has(name)).toBeTrue();
			expect(readRoleDefinition(production, name)?.tools).toEqual(expectedTools.get(name));
			expect(resolveRole(production, name)?.systemPrompt.trim()).not.toBe("");
		}
		expect(listRoles(production).sort()).toEqual([...expectedTools.keys()].sort());
		expect(resolveRole(production, "planner")?.delegates).toBeTrue();
		expect(resolveRole(production, "architect")?.goalLane).toBeUndefined();
		expect(resolveRole(production, "zipper")?.internal).toBeTrue();
	});
});

describe("argv construction", () => {
	function resolvedCoder() {
		writeRegistry({ coder: role("coder") });
		return resolveRole(registryFile, "coder")!;
	}

	test("passes provider, model, and prompt content explicitly", () => {
		const argv = buildArgv(resolvedCoder(), "do it", []);
		expect(argv[argv.indexOf("--provider") + 1]).toBe("kimi");
		expect(argv[argv.indexOf("--model") + 1]).toBe("k3");
		expect(argv[argv.indexOf("--system-prompt") + 1]).toContain("Do the thing carefully");
	});

	test("disables implicit context and preserves extension order", () => {
		const argv = buildArgv(resolvedCoder(), "do it", ["/a.ts", "/b.ts"]);
		expect(argv).toContain("--no-context-files");
		expect(argv.filter((_, index) => argv[index - 1] === "--extension")).toEqual(["/a.ts", "/b.ts"]);
	});

	test("uses an explicit tool allowlist when configured", () => {
		writeRegistry({ verify: role("verify", { tools: ["read", "bash"] }) });
		const argv = buildArgv(resolveRole(registryFile, "verify")!, "run", []);
		expect(argv[argv.indexOf("--tools") + 1]).toBe("read,bash");
		expect(buildArgv(resolvedCoder(), "run", [])).not.toContain("--tools");
	});

	test("passes prompt and persistent session as single arguments", () => {
		const argv = buildArgv(resolvedCoder(), "two words", [], {
			id: "run-1-goal-1-code",
			dir: "/tmp/codeflow-sessions",
		});
		expect(argv[argv.indexOf("-p") + 1]).toBe("two words");
		expect(argv[argv.indexOf("--session-id") + 1]).toBe("run-1-goal-1-code");
		expect(argv[argv.indexOf("--session-dir") + 1]).toBe("/tmp/codeflow-sessions");
	});
});

describe("allowed keys", () => {
	test("role policy keys are explicit", () => {
		expect([...ALLOWED_KEYS].sort()).toEqual([
			"delegates",
			"description",
			"goal_lane",
			"internal",
			"model",
			"needs_project_rules",
			"prompt",
			"tools",
		]);
	});
});

describe("run ids", () => {
	test("are sortable, timestamped, and unique", () => {
		const earlier = newRunId(new Date("2026-08-14T09:00:00.000Z"));
		const later = newRunId(new Date("2026-08-14T10:00:00.000Z"));
		expect(earlier).toMatch(/^run-20260814-090000-[0-9a-f]{4}$/);
		expect([later, earlier].sort()).toEqual([earlier, later]);
		expect(newRunId(new Date("2026-08-14T09:00:00.000Z"))).not.toBe(earlier);
	});
});
