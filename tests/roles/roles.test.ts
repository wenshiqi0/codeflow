/** Contract tests for the structured worker registry and Pi invocation. */

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
	fs.writeFileSync(registryFile, JSON.stringify({ roles }), "utf8");
}

function writePrompt(name: string, body = "Do the thing carefully.\n"): string {
	const relative = `references/capabilities/${name}.md`;
	const file = path.join(root, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body, "utf8");
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
	test("lists registry entries alphabetically", () => {
		writeRegistry({ worker: role("worker"), zipper: role("zipper") });
		expect(listRoles(registryFile)).toEqual(["worker", "zipper"]);
	});

	test("a missing registry yields no entries", () => {
		expect(listRoles(registryFile)).toEqual([]);
	});

	test("reads a definition without mixing it with prompt text", () => {
		writeRegistry({ worker: role("worker") });
		expect(readRoleDefinition(registryFile, "worker")).toMatchObject({ model: "kimi/k3" });
		expect(readRoleDefinition(registryFile, "ghost")).toBeNull();
	});

	test("rejects unknown configuration fields", () => {
		writeRegistry({ worker: role("worker", { mystery: true }) });
		expect(() => resolveRole(registryFile, "worker")).toThrow(RoleError);
	});
});

describe("resolution", () => {
	test("splits provider/model and loads the canonical prompt body", () => {
		const prompt = writePrompt("worker", "Canonical worker prompt.\n");
		writeRegistry({ worker: { description: "works", model: "kimi/k3", prompt } });
		const resolved = resolveRole(registryFile, "worker")!;
		expect(resolved.provider).toBe("kimi");
		expect(resolved.model).toBe("k3");
		expect(resolved.systemPrompt).toBe("Canonical worker prompt.\n");
		expect(resolved.promptPath).toBe(fs.realpathSync(path.join(root, prompt)));
	});

	test("an unknown entry resolves to null", () => {
		writeRegistry({});
		expect(resolveRole(registryFile, "ghost")).toBeNull();
	});

	test("rejects malformed or missing model bindings", () => {
		writeRegistry({ worker: role("worker", { model: "k3" }) });
		expect(() => resolveRole(registryFile, "worker")).toThrow("model must be '<provider>/<model>'");
		writeRegistry({ worker: { description: "works", prompt: writePrompt("worker") } });
		expect(() => resolveRole(registryFile, "worker")).toThrow("model must be a non-empty string");
	});

	test("rejects prompts outside references and missing prompts", () => {
		fs.writeFileSync(path.join(root, "outside.md"), "outside", "utf8");
		writeRegistry({ worker: role("worker", { prompt: "outside.md" }) });
		expect(() => resolveRole(registryFile, "worker")).toThrow(
			"prompt must be Markdown below references/",
		);
		writeRegistry({ worker: role("worker", { prompt: "references/capabilities/missing.md" }) });
		expect(() => resolveRole(registryFile, "worker")).toThrow("prompt is unreadable");
	});

	test("validates tools and context policy", () => {
		writeRegistry({ worker: role("worker", { tools: "read,bash" }) });
		expect(() => resolveRole(registryFile, "worker")).toThrow("tools must be an array");
		writeRegistry({ worker: role("worker", { needs_project_rules: "sometimes" }) });
		expect(() => resolveRole(registryFile, "worker")).toThrow(
			"needs_project_rules must be false, shared, or full",
		);
	});

	test("production registry contains equal workers and the internal zipper", () => {
		const production = path.resolve(import.meta.dir, "../../runtime/roles.json");
		expect(listRoles(production)).toEqual(["worker", "zipper"]);
		const worker = resolveRole(production, "worker")!;
		expect(worker).toMatchObject({
			provider: "zhipuai-coding-plan",
			model: "glm-5.3",
			needsProjectRules: "shared",
			internal: false,
		});
		expect(readRoleDefinition(production, "worker")?.prompt).toBe(
			"references/capabilities/worker.md",
		);
		expect(resolveRole(production, "zipper")?.internal).toBeTrue();
	});
});

describe("argv construction", () => {
	function resolvedWorker() {
		writeRegistry({ worker: role("worker") });
		return resolveRole(registryFile, "worker")!;
	}

	test("passes provider, model, and prompt content explicitly", () => {
		const argv = buildArgv(resolvedWorker(), "run", []);
		expect(argv).toContain("--provider");
		expect(argv).toContain("--model");
		expect(argv).toContain("--system-prompt");
	});

	test("disables implicit context and preserves extension order", () => {
		const argv = buildArgv(resolvedWorker(), "do it", ["/a.ts", "/b.ts"]);
		expect(argv).toContain("--no-context-files");
		expect(argv.filter((_, index) => argv[index - 1] === "--extension")).toEqual(["/a.ts", "/b.ts"]);
	});

	test("uses an explicit tool allowlist when configured", () => {
		writeRegistry({ worker: role("worker", { tools: ["read", "bash"] }) });
		const argv = buildArgv(resolveRole(registryFile, "worker")!, "run", []);
		expect(argv[argv.indexOf("--tools") + 1]).toBe("read,bash");
		expect(buildArgv(resolvedWorker(), "run", [])).not.toContain("--tools");
	});

	test("passes prompt and persistent session as single arguments", () => {
		const argv = buildArgv(resolvedWorker(), "two words", [], {
			id: "run-1-goal-1-thread",
			dir: "/tmp/codeflow-sessions",
		});
		expect(argv[argv.indexOf("-p") + 1]).toBe("two words");
		expect(argv[argv.indexOf("--session-id") + 1]).toBe("run-1-goal-1-thread");
		expect(argv[argv.indexOf("--session-dir") + 1]).toBe("/tmp/codeflow-sessions");
	});
});

describe("allowed keys", () => {
	test("registry policy keys are explicit", () => {
		expect([...ALLOWED_KEYS].sort()).toEqual([
			"description",
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
