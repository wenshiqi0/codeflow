import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadContextImports } from "../../runtime/extensions/codeflow-context/imports";
import { listRoles, resolveRole } from "../../runtime/lib/roles";

const repo = path.resolve(import.meta.dir, "../..");

function read(relative: string): string {
	return fs.readFileSync(path.join(repo, relative), "utf8");
}

function exists(relative: string): boolean {
	return fs.existsSync(path.join(repo, relative));
}

describe("runtime architecture boundaries", () => {
	test("role references are injected through the context import graph", () => {
		const registry = path.join(repo, "runtime/roles.json");
		for (const name of listRoles(registry)) {
			const prompt = resolveRole(registry, name)?.systemPrompt ?? "";
			loadContextImports(prompt, path.join(repo, "runtime"));
			expect(prompt).not.toContain("$PI_CODING_AGENT_DIR/../references");
		}
		expect(read("runtime/AGENTS.md")).not.toContain("$PI_CODING_AGENT_DIR/../references");
		expect(fs.existsSync(path.join(repo, "runtime/agents"))
			? fs.readdirSync(path.join(repo, "runtime/agents")).filter((file) => file.endsWith(".md"))
			: []).toEqual([]);
	});

	test("roles receive a direct read-only runtime locator", () => {
		const sharedRules = read("runtime/AGENTS.md");
		const run = read("runtime/cli/run.ts");
		const launcher = read("runtime/extensions/codeflow-task/role-launcher.ts");
		const context = read("runtime/extensions/codeflow-context/index.ts");
		const guard = read("runtime/extensions/host-guard/policy.ts");
		expect(sharedRules).toContain("$PI_CODING_AGENT_DIR");
		expect(sharedRules).toContain("read-only during a business run");
		expect(run).toContain("PI_CODING_AGENT_DIR: RUNTIME_DIR");
		expect(launcher).toContain("PI_CODING_AGENT_DIR: RUNTIME_DIR");
		expect(context).not.toContain("delete process.env.PI_CODING_AGENT_DIR");
		expect(guard).toContain("Codeflow runtime is read-only during a run");
		expect(read("runtime/bin/codeflow")).not.toContain("export PI_CODING_AGENT_DIR");
		expect(read("runtime/bin/code-agent")).not.toContain("export PI_CODING_AGENT_DIR");
	});

	test("internal capability prompts are references rather than discoverable skills", () => {
		expect(exists("runtime/skills")).toBe(false);
		const capabilities = [
			"architecture.md",
			"planning.md",
			"testing.md",
			"implementation.md",
				"verification.md",
				"supervision.md",
				"output-compression.md",
		];
		for (const name of capabilities) {
			const file = read(path.join("references/capabilities", name));
			expect(file).not.toMatch(/^name:\s*/m);
			expect(file).not.toMatch(/^---\s*$/m);
		}
	});

	test("CLI adapters live outside the core library", () => {
		for (const name of ["run.ts", "outer.ts", "handoff.ts", "status.ts"]) {
			expect(exists(path.join("runtime/cli", name))).toBe(true);
			expect(exists(path.join("runtime/lib", `cli-${name.replace(".ts", "")}.ts`))).toBe(false);
		}
		expect(read("runtime/bin/codeflow")).toContain('CLI_DIR="$RUNTIME_DIR/cli"');
		expect(read("runtime/bin/code-agent")).toContain('CLI_DIR="$RUNTIME_DIR/cli"');
	});

	test("handoff is a core module with a stable public entry", () => {
		expect(exists("runtime/lib/handoff/index.ts")).toBe(true);
		expect(exists("runtime/lib/handoff.ts")).toBe(false);
	});

	test("quality tooling is separated from core state", () => {
		expect(exists("runtime/quality/test-patch.ts")).toBe(true);
		expect(exists("runtime/lib/test-patch.ts")).toBe(false);
		expect(read("runtime/bin/code-agent")).toContain('QUALITY_DIR="$RUNTIME_DIR/quality"');
	});

	test("typecheck is part of the standard gate", () => {
		const pkg = JSON.parse(read("package.json"));
		expect(pkg.scripts.typecheck).toBe("tsc -p tsconfig.json");
		expect(exists("tsconfig.json")).toBe(true);
	});

	test("root and delegated roles load the host runtime guard", () => {
		const run = read("runtime/cli/run.ts");
		const launcher = read("runtime/extensions/codeflow-task/role-launcher.ts");
		expect(run).toContain("host-guard");
		expect(launcher).toContain("HOST_GUARD_EXTENSION");
	});

	test("the root process exports one absolute run-state root to every worktree", () => {
		const run = read("runtime/cli/run.ts");
		expect(run).toContain("path.resolve(cwd, configured ?? DEFAULT_RUNS_DIR)");
		expect(run).toContain("CODEFLOW_RUNS_DIR: runsDir");
	});

	test("root, delegated, and isolated support roles load dynamic provider profiles", () => {
		const run = read("runtime/cli/run.ts");
		const launcher = read("runtime/extensions/codeflow-task/role-launcher.ts");
		const compressor = read("runtime/extensions/bash-compressor/index.ts");
		expect(run).toContain('extensions", "provider-profiles"');
		expect(launcher).toContain("PROVIDER_PROFILES_EXTENSION");
		expect(compressor).toContain("PROVIDER_PROFILES_EXTENSION");
		expect(compressor).toContain('"--no-extensions"');
	});

	test("task extension separates tool registration, registry, and child launching", () => {
		for (const name of ["index.ts", "registry.ts", "role-launcher.ts", "handoff-gate.ts"]) {
			expect(exists(path.join("runtime/extensions/codeflow-task", name))).toBe(true);
		}
		const index = read("runtime/extensions/codeflow-task/index.ts");
		const launcher = read("runtime/extensions/codeflow-task/role-launcher.ts");
		expect(index).toContain('from "./registry"');
		expect(index).toContain('from "./role-launcher"');
		expect(launcher).toContain("export async function runRoleChild");
	});

	test("doctor derives credentials from runtime configuration", () => {
		const doctor = read("scripts/doctor.sh");
		expect(doctor).toContain("models.json");
		expect(doctor).toContain("providers.json");
		expect(doctor).toContain("roles.json");
		expect(doctor).not.toContain("test-writer");
		expect(doctor).not.toContain("test-runner");
		expect(doctor).not.toContain("command,");
		expect(doctor).not.toContain("directory-policy");
	});

	test("README documents the layer contracts and dependency direction", () => {
		const readme = read("README.md");
		expect(readme).toContain("## 分层约束");
		expect(readme).toContain("| `runtime/cli/` | CLI adapter |");
		expect(readme).toContain("| `runtime/lib/` | 可复用核心机制 |");
		expect(readme).toContain("| `runtime/extensions/` | Pi event/tool adapter |");
		expect(readme).toContain("### 依赖方向");
		expect(readme).toContain("runtime/bin");
		expect(readme).toContain("runtime/cli");
		expect(readme).toContain("runtime/lib");
		expect(readme).toContain("runtime/extensions");
		expect(readme).toContain("### 文件归属规则");
		expect(readme).toContain("`scripts/doctor.sh` 不维护第二份角色清单");
	});
});
