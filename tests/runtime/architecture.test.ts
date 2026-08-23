import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "../..");

function filesBelow(directory: string): string[] {
	const files: string[] = [];
	const walk = (current: string) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else files.push(full);
		}
	};
	walk(directory);
	return files;
}

describe("single current architecture", () => {
	test("removed runtime subsystems and registries do not exist", () => {
		for (const relative of [
			"runtime/roles.json",
			"runtime/lib/roles.ts",
			"runtime/lib/facts.ts",
			"runtime/lib/collaboration-index.ts",
			"runtime/lib/workspace-state.ts",
			"runtime/extensions/codeflow-task",
			"runtime/quality/test-patch.ts",
			"runtime/cli/handoff.ts",
		]) expect(fs.existsSync(path.join(root, relative))).toBe(false);
	});

	test("active runtime has no compatibility identity or mutable-state API", () => {
		const files = [
			...filesBelow(path.join(root, "runtime")),
			...filesBelow(path.join(root, "benchmark")),
		].filter((file) => /\.(ts|json|sh)$/.test(file));
		const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
		for (const residue of [
			"CODEFLOW_AGENT_ROLE",
			"CODEFLOW_AGENT_DEPTH",
			"CODEFLOW_THREAD",
			"roles.json",
			"codeflow-task",
			"facts.jsonl",
			"acceptance_context",
			"goal_lane",
			"_ungrouped",
			"_default",
		]) expect(source).not.toContain(residue);
	});

	test("organization has no code-agent command bypass", () => {
		const launcher = fs.readFileSync(path.join(root, "runtime/bin/code-agent"), "utf8");
		expect(launcher).not.toContain("handoff open");
		expect(launcher).not.toContain("goal create");
		expect(launcher).toContain("receipt submit");
		expect(launcher).toContain("recall goal");
	});

	test("a Worker cannot recursively start another Task", () => {
		const result = Bun.spawnSync(
			["bash", path.join(root, "runtime/bin/codeflow"), "exec", "nested"],
			{ cwd: root, env: { ...process.env, CODEFLOW_RUN_ID: "task-existing" } },
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("cannot start inside a Codeflow Task");
	});
});
