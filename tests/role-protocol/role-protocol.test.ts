/**
 * Contract tests for the capability-oriented role protocol.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const runtimeDir = path.resolve(import.meta.dir, "../../runtime");

function read(relativePath: string): string {
	return fs.readFileSync(path.join(runtimeDir, relativePath), "utf8");
}

describe("capability-oriented role protocol", () => {
	test("flow roles and support roles form the intended roster", () => {
		const expected = [
			"architect.md",
			"coder.md",
			"planner.md",
			"supervisor.md",
			"tester.md",
			"title-compressor.md",
			"verify.md",
			"zipper.md",
		];
		expect(fs.readdirSync(path.join(runtimeDir, "agents")).sort()).toEqual(expected);
		expect(read("../references/roles.md")).toContain("## Flow roles");
		expect(read("../references/roles.md")).toContain("## Support roles");
	});

	test("planner composes capabilities instead of prescribing a fixed sequence", () => {
		const planner = read("agents/planner.md");
		expect(planner).toContain("## Capability map");
		expect(planner).toContain("`architect` clarifies direction");
		expect(planner).toContain("`tester` converts product intent");
		expect(planner).toContain("`coder` owns the technical surface");
		expect(planner).toContain("`verify` creates independent execution evidence");
		expect(planner).toContain("capabilities rather than mandatory stations");
		expect(planner).not.toContain("## Order");
		expect(planner).not.toContain("in this order");
		expect(planner).not.toContain("Call `task` with `goal_id`");
	});

	test("industry patterns are described as conditional lenses", () => {
		const patterns = read("../references/patterns.md");
		expect(patterns).toContain("not mandatory workflow stages");
		expect(patterns).toContain("## Test-driven development");
		expect(patterns).toContain("Strong when the technical surface is stable enough to compile");
		expect(patterns).toContain("Compile failure is test-authoring or setup feedback");
		expect(patterns).toContain("## Diagnosis-first");
		expect(patterns).toContain("## Baseline-preserving refactoring");
		expect(patterns).toContain("## Benchmark-driven change");
		expect(patterns).toContain("## Pattern composition");
	});

	test("tester owns case design and executable business tests", () => {
		const tester = read("agents/tester.md");
		const testing = read("../references/capabilities/testing.md");
		const reference = read("../references/testing.md");

		for (const text of [tester, testing, reference]) {
			expect(text).toContain("case");
			expect(text).toContain("observable");
		}
		expect(tester).toContain("business case design");
		expect(tester).toContain("executable business tests");
		expect(tester).toContain("boundary and equivalence analysis");
		expect(testing).toContain("exact runner command");
		expect(reference).toContain("`verify` independently owns execution evidence");
	});

	test("coder treats TDD as one useful pattern rather than an identity", () => {
		const coder = read("agents/coder.md");
		const implementation = read("../references/capabilities/implementation.md");
		const style = read("../references/engineering-style.md");

		for (const text of [coder, implementation, style]) {
			expect(text).toContain("TDD");
		}
		expect(coder).toContain("TDD is a high-leverage pattern");
		expect(coder).toContain("scaffold-first");
		expect(coder).toContain("diagnosis-first");
		expect(coder).toContain("benchmark-driven optimization");
		expect(implementation).toContain("The mode may change as evidence arrives");
		expect(style).toContain("not mechanical path rules");
		expect(style).toContain("business tests separate from product code");
	});

	test("architecture is a direction and reversibility capability", () => {
		const architect = read("agents/architect.md");
		const architecture = read("../references/architecture.md");
		expect(architect).toContain("direction, reversibility, boundaries, and fitness functions");
		expect(architect).toContain("architecture decision records");
		expect(architecture).toContain("Reversibility");
		expect(architecture).toContain("Fitness functions");
		expect(architecture).toContain("ignore rule for `/target/`");
	});

	test("verify owns independent execution evidence", () => {
		const verify = read("agents/verify.md");
		const verification = read("../references/capabilities/verification.md");
		expect(verify).toContain("independent observation instrument");
		expect(verify).toContain("`EXPECTED_FAIL`");
		expect(verify).toContain("`RUNNER_BLOCKED`");
		expect(verify).toContain("`POST_IMPLEMENTATION_FAIL`");
		expect(verification).toContain("exact commands");
		expect(verification).toContain("next owner");
	});

	test("handoffs carry semantic outcome and evidence contracts", () => {
		const handoff = read("../references/capabilities/handoff.md");
		expect(handoff).toContain("**Outcome:**");
		expect(handoff).toContain("**Intent:**");
		expect(handoff).toContain("**Evidence sought:**");
		expect(handoff).toContain("Scope is orientation, not a filesystem permission");
	});

	test("planner closes the root handoff mechanically", () => {
		const planner = read("agents/planner.md");
		expect(planner).toContain("mandatory closure artifact");
		expect(planner).toContain("--artifact <closure artifact path>");
		expect(planner).toContain("The `handoff finish` command owns terminal completion");
	});

	test("role prompts use positive ownership language", () => {
		for (const name of fs.readdirSync(path.join(runtimeDir, "agents"))) {
			if (!name.endsWith(".md")) continue;
			const text = read(path.join("agents", name));
			expect(text).not.toMatch(/\bNever\b/);
			expect(text).not.toMatch(/\bDo not\b/);
			expect(text).not.toMatch(/\bdo not\b/);
		}
	});
});
