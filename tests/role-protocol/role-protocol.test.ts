/**
 * Contract tests for the two-layer test protocol:
 *
 * 1. test-writer owns product acceptance tests as an immutable hard lock;
 * 2. coder owns just-in-time unit tests and implements a cohesive batch of
 *    related RED/GREEN units, persisting enough state to continue cleanly.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const runtimeDir = path.resolve(import.meta.dir, "../../runtime");

function read(relativePath: string): string {
	return fs.readFileSync(path.join(runtimeDir, relativePath), "utf8");
}

describe("two-layer test protocol", () => {
	test("test writing and implementation use GLM 5.3", () => {
		const testWriter = read("agents/test-writer.md");
		const coder = read("agents/coder.md");
		const registry = JSON.parse(read("models.json"));
		const zhipuModels = registry.providers["zhipuai-coding-plan"].models.map(
			(model: { id: string }) => model.id,
		);

		expect(testWriter).toContain("model: zhipuai-coding-plan/glm-5.3");
		expect(coder).toContain("model: zhipuai-coding-plan/glm-5.3");
		expect(zhipuModels).toContain("glm-5.3");
	});

	test("planner delegates cohesive developer batches, not single tests", () => {
		const planner = read("agents/planner.md");

		expect(planner).toContain("business tests");
		expect(planner).toContain("Unit tests belong to the coder");
		expect(planner).toContain("These tests are the business hard lock");
		expect(planner).toContain("Unit tests belong to the coder");
		expect(planner).toContain("One coder handoff covers one cohesive developer batch");
		expect(planner).toContain("several related unit tests");
		expect(planner).toContain("one to two working days");
		expect(planner).toContain("Coder decides the exact unit-test decomposition");
		expect(planner).toContain("test/code/verify lane sessions are continuous");
		expect(planner).toContain("Do not delegate an entire milestone");
	});

	test("planner creates immutable goals without goal state", () => {
		const planner = read("agents/planner.md");

		expect(planner).toContain("The goal is not an agent and has no state machine");
		expect(planner).toContain("Call `goal` once per goal");
		expect(planner).toContain("Never change an existing goal contract");
		expect(planner).toContain("derive progress from the test/code/verify handoffs");
		expect(planner).toContain("Do not run parallel tasks in the same goal lane");
		expect(planner).toContain("Limit two test repairs per goal");
	});

	test("planner uses test-writer and architect at different decision layers", () => {
		const planner = read("agents/planner.md");

		expect(planner).toContain("one business requirement");
		expect(planner).toContain("Delegate architecture decisions to `architect`");
		expect(planner).toContain("greenfield project initialization");
		expect(planner).toContain("anti-degradation gates");
		expect(planner).toContain("new direction/dependency");
	});

	test("handoff contract names the business contract and developer batch plan separately", () => {
		const skill = read("skills/write-handoff/SKILL.md");

		expect(skill).toContain("Business contract");
		expect(skill).toContain("tests/biz/<goal-id>/");
		expect(skill).toContain("Developer batch plan");
		expect(skill).toContain("unit tests are coder-owned");
		expect(skill).toContain("coder decides the exact unit-test decomposition");
		expect(skill).toContain("one to two working days");
	});

	test("test-writer designs observable acceptance tests, not implementation unit tests", () => {
		const agent = read("agents/test-writer.md");
		const skill = read("skills/write-tests/SKILL.md");

		for (const text of [agent, skill]) {
			expect(text).toContain("business tests");
			expect(text).toContain("observable product behavior");
			expect(text).toContain("one business requirement per handoff");
			expect(text).toContain("Directly write business tests");
			expect(text).toContain("tests/biz/");
			expect(text).toContain("Do not design coder-owned unit tests");
			expect(text).toContain("checkpoint");
		}

		expect(agent).toContain("Do not accept a handoff that bundles multiple business requirements");
		expect(agent).toContain("Do not create a test patch");
		expect(agent).toContain("--artifact <test index path>");
	});

	test("RED is a coarse runtime preflight followed by bounded repair", () => {
		const planner = read("agents/planner.md");
		const runner = read("agents/test-runner.md");

		expect(planner).toContain("RED is the runtime preflight");
		expect(planner).toContain("no separate full runtime preflight handoff");
		expect(runner).toContain("failure_class");
		expect(runner).toContain("EXPECTED_FAIL");
		expect(runner).toContain("UNEXPECTED_PASS");
		expect(runner).toContain("RUNNER_BLOCKED");
		expect(runner).toContain("POST_IMPLEMENTATION_FAIL");
		expect(runner).toContain("UNCERTAIN");
		expect(runner).toContain("Use only coarse RED classification");
		expect(runner).toContain("do not claim it proves a specific missing contract");
	});

	test("coder runs a multi-test TDD batch and checkpoints its completion", () => {
		const agent = read("agents/coder.md");
		const skill = read("skills/implement-change/SKILL.md");

		for (const text of [agent, skill]) {
			expect(text).toContain("write the unit tests first");
			expect(text).toContain("RED");
			expect(text).toContain("GREEN");
			expect(text).toContain("several focused unit tests");
			expect(text).toContain("single unit test");
			expect(text).toContain("cohesive set of product files");
			expect(text).toContain("batch checkpoint");
			expect(text).toContain("Never edit business tests in `tests/biz/`");
		}

		expect(agent).toContain("Write the final batch checkpoint before starting another batch");
		expect(agent).toContain("Update the batch checkpoint after every GREEN cluster");
		expect(agent).toContain("--artifact <batch checkpoint path>");
	});

	test("coder preferences live in a reference and enforce separated test trees", () => {
		const agent = read("agents/coder.md");
		const reference = read("../references/coder-preferences.md");

		expect(agent).toContain("references/coder-preferences.md");
		expect(reference).toContain("Keep tests out of source directories");
		expect(reference).toContain("tests/biz/<goal-id>/");
		expect(reference).toContain("tests/unit/");
		expect(reference).toContain("Do not place test files beside production files");
		expect(reference).toContain("Business tests and developer unit tests are separate");
		expect(reference).toContain("Several related unit tests usually form one batch");
		expect(reference).toContain("one to two working days");
		expect(reference).toContain("Do not make one unit test one handoff by default");
	});

	test("coder preferences require type safety and discipline around any", () => {
		const agent = read("agents/coder.md");
		const skill = read("skills/implement-change/SKILL.md");
		const reference = read("../references/coder-preferences.md");

		for (const text of [agent, skill, reference]) {
			expect(text).toContain("Type safety is required");
			expect(text).toContain("do not use `any` by default");
			expect(text).toContain("document the conflict and the narrowing alternative that failed");
		}

		expect(reference).toContain("Use `unknown` plus narrowing at boundaries");
		expect(reference).toContain("Prefer precise interfaces, generics, discriminated unions, and type guards");
	});

	test("supporting planning and verification docs preserve both test layers", () => {
		const plan = read("skills/plan-change/SKILL.md");
		const verify = read("skills/verify-change/SKILL.md");
		const roles = read("../references/roles.md");

		expect(plan).toContain("business acceptance criteria");
		expect(plan).toContain("Developer batch plan");
		expect(plan).toContain("unit tests are coder-owned");
		expect(verify).toContain("business tests");
		expect(verify).toContain("coder-owned unit tests");
		expect(roles).toContain("Direct `tests/biz/` business test authoring");
		expect(roles).toContain("developer unit tests");
	});

	test("architect owns initialization, degradation, and direction decisions", () => {
		const agent = read("agents/architect.md");
		const roles = read("../references/roles.md");

		expect(agent).toContain("Architecture Decision Maker");
		expect(agent).toContain("greenfield project initialization");
		expect(agent).toContain("anti-degradation gates");
		expect(agent).toContain("new direction or dependency");
		expect(agent).toContain("Never edit product code, tests, configuration, or dependencies");
		expect(agent).toContain("--artifact <architecture decision artifact path>");
		expect(roles).toContain("`architect`");
	});

	test("architect preferences live in a reference and set default technology direction", () => {
		const agent = read("agents/architect.md");
		const reference = read("../references/architect-preferences.md");

		expect(agent).toContain("references/architect-preferences.md");
		expect(reference).toContain("Frontend and Node/Bun projects prefer TypeScript");
		expect(reference).toContain("choose the latest stable version");
		expect(reference).toContain("Lock the major version with semver ranges");
		expect(reference).toContain("minor and patch/hotfix updates remain allowed");
		expect(reference).toContain("Desktop and cross-platform projects prefer Rust");
		expect(reference).toContain("render through native UI components");
		expect(reference).toContain("computer-use accessibility/AX tree requirements");
		expect(reference).toContain("use a Rust-based WebAssembly solution");
		expect(reference).toContain("organize the work as a monorepo");
	});

	test("command completion is recorded before narration", () => {
		const agent = read("agents/command.md");

		expect(agent).toContain("write the receipt and run `handoff finish` before narrating success");
		expect(agent).toContain("Never present a final prose summary as completion evidence");
	});

	test("planner stops on provider failure instead of spawning replacements", () => {
		const planner = read("agents/planner.md");

		expect(planner).toContain("If a child reports `PROVIDER_FAILURE`");
		expect(planner).toContain("do not open a replacement child for the same work");
		expect(planner).toContain("explicit user-directed corrective run or model change");
	});
});
