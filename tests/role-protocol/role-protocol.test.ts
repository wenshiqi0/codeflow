/** Contract tests for the capability-oriented role protocol. */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { listRoles, readRoleDefinition, resolveRole } from "../../runtime/lib/roles";

const repo = path.resolve(import.meta.dir, "../..");
const runtimeDir = path.join(repo, "runtime");
const registry = path.join(runtimeDir, "roles.json");

function read(relativePath: string): string {
	return fs.readFileSync(path.join(repo, relativePath), "utf8");
}

function prompt(role: string): string {
	return resolveRole(registry, role)?.systemPrompt ?? "";
}

describe("capability-oriented role protocol", () => {
	test("one structured registry points to one canonical prompt per role", () => {
		expect(listRoles(registry)).toEqual([
			"architect",
			"coder",
			"planner",
			"supervisor",
			"tester",
			"verify",
			"zipper",
		]);
		const refs = new Set<string>();
		for (const role of listRoles(registry)) {
			const definition = readRoleDefinition(registry, role)!;
			expect(definition.prompt).toStartWith("references/capabilities/");
			expect(refs.has(definition.prompt)).toBeFalse();
			refs.add(definition.prompt);
			expect(prompt(role).trim()).not.toBe("");
			expect(prompt(role)).not.toContain("codeflow:import");
		}
		const legacyAgents = path.join(runtimeDir, "agents");
		expect(fs.existsSync(legacyAgents)
			? fs.readdirSync(legacyAgents).filter((name) => name.endsWith(".md"))
			: []).toEqual([]);
	});

	test("planner is a bounded coordinator rather than a technical researcher", () => {
		const planner = prompt("planner");
		expect(planner).toContain("root coordinator");
		expect(planner).toContain("five read-only information calls or five minutes");
		expect(planner).toContain("Reaching the budget is a stop condition");
		expect(planner).toContain("repository discovery, files and symbols");
		expect(planner).toContain("SSOT");
		expect(planner).toContain("stay at the behavior level");
		expect(planner).toContain("Aim below 2,000 characters");
		expect(planner).toContain("rejects task prompts above 4,000 characters");
		expect(planner).not.toContain("## Pattern judgment");
		expect(planner).not.toContain("references/patterns.md");

		const definition = readRoleDefinition(registry, "planner")!;
		expect(definition.model).toBe("zhipuai-coding-plan/glm-5.3");
		expect(definition.tools).toEqual(["read", "write", "bash", "goal", "task", "task_group"]);
		expect(definition.delegates).toBeTrue();
	});

	test("specialist ownership is precise and non-overlapping", () => {
		const tester = prompt("tester");
		expect(tester).toContain("authoritative product contracts and SSOT interpretation");
		expect(tester).toContain("executable business tests");
		expect(tester).toContain("exact runner command");

		const coder = prompt("coder");
		expect(coder).toContain("repository discovery, files and symbols, API and wire mapping");
		expect(coder).toContain("developer unit tests");
		expect(coder).toContain("diagnosis-first");
		expect(coder).toContain("benchmark-driven optimization");

		const verify = prompt("verify");
		expect(verify).toContain("independent observation instrument");
		expect(verify).toContain("code-agent evidence run");
		expect(verify).toContain("integer `exit_code`");
		expect(verify).toContain("`RUNNER_BLOCKED`");
		expect(verify).toContain("Clean `PASS` entries omit `failure_class`");
	});

	test("architect stays advisory and outside goal lanes", () => {
		const architect = prompt("architect");
		const planner = prompt("planner");
		expect(architect).toContain("architecture advisor");
		expect(architect).toContain("reversibility");
		expect(architect).toContain("anti-degradation");
		expect(readRoleDefinition(registry, "architect")?.goal_lane).toBeUndefined();
		expect(planner).toContain("`architect` is advisory and intentionally unlaned");
		expect(planner).toContain("omit `goal_id` and `lane`");
	});

	test("polling cases diagnose a focused path before timeout escalation", () => {
		const tester = prompt("tester");
		expect(tester).toContain("`poll_interval`");
		expect(tester).toContain("`max_wait`");
		expect(tester).toMatch(/30[–-]60 seconds/);
		expect(tester).toContain("single named test");
		expect(tester).toContain("protocol/state transition");
	});

	test("planner handoffs and root closure are concise mechanical contracts", () => {
		const planner = prompt("planner");
		for (const section of ["**Outcome:**", "**Intent:**", "**Evidence:**", "**Boundaries:**", "**Ownership:**"]) {
			expect(planner).toContain(section);
		}
		expect(planner).toContain("non-empty JSON root receipt");
		expect(planner).toContain("--artifact <closure artifact path>");
		expect(planner).toContain("The CLI transition, not final prose, completes the run");
	});

	test("mechanical finish rejection permits one repair without hidden retries", () => {
		const sharedRules = read("runtime/AGENTS.md");
		expect(sharedRules).toContain("If `handoff finish` is rejected by CLI validation");
		expect(sharedRules).toContain("the handoff is still non-terminal");
		expect(sharedRules).toContain("call `handoff finish` once more");
		expect(sharedRules).toContain("This repair rule does not apply to business failures");

		const verification = prompt("verify");
		expect(verification).toContain("the handoff is still non-terminal");
		expect(verification).toContain("call `handoff finish` once more");

		const supervision = prompt("supervisor");
		expect(supervision).toContain("call finish once more");
	});

	test("multi-goal parallelism is limited to initial independent test lanes", () => {
		const planner = prompt("planner");
		expect(planner).toContain("use `task_group` to start exactly one initial `tester` handoff per goal");
		expect(planner).toContain("This is the only default parallel batch");
		expect(planner).toContain("keep each goal's subsequent `code` and `verify` handoffs serial");
		expect(planner).toContain("If goals share files, contracts, or ordering, keep them serial");
	});

	test("support prompts remain narrow", () => {
		expect(prompt("supervisor")).toContain("only deterministic checks named by the handoff");
		expect(prompt("zipper")).toContain("at most 4,000 characters");
		expect(readRoleDefinition(registry, "zipper")?.internal).toBeTrue();
	});

	test("role reference documents describe the split source of truth", () => {
		const roles = read("references/roles.md");
		expect(roles).toContain("`runtime/roles.json` is the only role registry");
		expect(roles).toContain("Runtime has no parallel agent Markdown layer");
		expect(roles).toContain("## Flow roles");
		expect(roles).toContain("## Support roles");
	});
});
