import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const repo = path.resolve(import.meta.dir, "../..");

function read(relative: string): string {
	return fs.readFileSync(path.join(repo, relative), "utf8");
}

function exists(relative: string): boolean {
	return fs.existsSync(path.join(repo, relative));
}

describe("runtime architecture boundaries", () => {
	test("internal capability prompts are references rather than discoverable skills", () => {
		expect(exists("runtime/skills")).toBe(false);
		const capabilities = [
			"planning.md",
			"testing.md",
			"implementation.md",
			"verification.md",
			"handoff.md",
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
		expect(doctor).toContain("runtime/agents");
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
