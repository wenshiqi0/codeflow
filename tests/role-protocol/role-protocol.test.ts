import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { listRoles, resolveRole } from "../../runtime/lib/roles";

const repo = path.resolve(import.meta.dir, "../..");
const registry = path.join(repo, "runtime/roles.json");

describe("equal worker protocol", () => {
	test("the registry has one non-internal worker binding", () => {
		expect(listRoles(registry)).toEqual(["worker", "zipper"]);
		const worker = resolveRole(registry, "worker")!;
		expect(worker.model).toBe("glm-5.3");
		expect(worker.provider).toBe("zhipuai-coding-plan");
		expect(worker.tools).toEqual([]);
		expect(worker.internal).toBeFalse();
	});

	test("retired identity prompts and registry entries are absent", () => {
		for (const name of [
			"planner.md",
			"testing.md",
			"implementation.md",
			"verification.md",
			"architecture.md",
			"supervision.md",
		]) {
			expect(fs.existsSync(path.join(repo, "references/capabilities", name))).toBeFalse();
		}
		for (const name of ["planner", "tester", "coder", "verify", "architect", "supervisor"]) {
			expect(listRoles(registry)).not.toContain(name);
		}
	});

	test("work methods remain neutral choices rather than identities", () => {
		const worker = fs.readFileSync(
			path.join(repo, "references/capabilities/worker.md"),
			"utf8",
		);
		expect(worker).toContain("direct implementation");
		expect(worker).toContain("diagnosis-first work");
		expect(worker).toContain("test-driven development");
		expect(worker).toContain("A worker may use, combine, adapt, or omit these");
		expect(worker).not.toMatch(/\btester\b|\bcoder\b|\bverify\b|\barchitect\b/i);
	});
});
