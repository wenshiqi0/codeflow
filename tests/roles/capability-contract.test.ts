import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const capabilities = path.join(ROOT, "references/capabilities");

function prompt(name: string): string {
	return fs.readFileSync(path.join(capabilities, name), "utf8");
}

describe("capability prompt contracts", () => {
	test("tester uses the recorder, one node id, and delegates full regression", () => {
		const testing = prompt("testing.md");
		expect(testing).toContain("code-agent evidence run --id <case-id>");
		expect(testing).toContain("exactly one test node id");
		expect(testing).not.toContain("On review, assess the business tests");
		expect(testing).toContain("Full regression belongs to `verify`, at most once per goal");
	});

	test("verify owns post-implementation evidence review and assertion intent", () => {
		const verification = prompt("verification.md");
		const planning = prompt("planning.md");
		expect(verification).toContain(
			"including whether business assertions still express the tester's recorded intent",
		);
		expect(planning).toContain(
			"post-implementation evidence review -> `verify`; re-engage `tester` only for disputed assertion intent",
		);
	});

	test("planner splits context-budget events and stops satisfied-goal loops", () => {
		const planning = prompt("planning.md");
		expect(planning).toContain(
			"`CONTEXT_BUDGET_EXCEEDED` from a lane means the work unit was too large",
		);
		expect(planning).toContain(
			"Once a goal's join is satisfied, do not open further lane handoffs for it",
		);
	});
});
