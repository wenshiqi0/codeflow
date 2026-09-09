import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import organization from "../../runtime/extensions/codeflow-organization";
import { buildWorkerContext } from "../../runtime/extensions/codeflow-context/context";
import { RunPaths } from "../../runtime/lib/paths";
import { createTask } from "../../runtime/lib/tasks";
import { claimTestWork } from "./helpers";

const root = path.resolve(import.meta.dir, "../..");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("Pi executor prompt contracts", () => {
	test("the configured Agent contract keeps context pull-first", () => {
		const config = JSON.parse(fs.readFileSync(path.join(root, "runtime/config.json"), "utf8"));
		expect(config.agent.prompt).toBe("references/agent.md");
		const agent = fs.readFileSync(path.join(root, config.agent.prompt), "utf8");
		for (const noun of ["Goal", "Commitment", "Receipt", "Agent"]) expect(agent).toContain(noun);
		expect(agent).not.toMatch(/obligation\.|decomposition:|claim_revision|invariant|falsification|recall level|superseded|partial Receipt|failed Receipt/i);
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-prompt-"));
		dirs.push(temp);
		const paths = new RunPaths(path.join(temp, "runs"), "task-prompt");
		createTask(paths, "verify prompt");
		const commitment = claimTestWork(paths, { goalId: paths.runId, work: "verify the prompt" });
		expect(buildWorkerContext(paths, paths.runId, commitment).sources.map((source) => source.kind))
			.toEqual(["goal", "current_commitment", "current_commitment_folded"]);
		expect(fs.readFileSync(path.join(root, "runtime/AGENTS.md"), "utf8")).toContain(`../${config.agent.prompt}`);
	});
	test("only three-action metadata is exposed without hidden prompt fragments", () => {
		const tools: any[] = [];
		organization({ on() {}, registerTool(value: unknown) { tools.push(value); } } as never);
		expect(tools).toHaveLength(1);
		const tool = tools[0];
		expect(tool.name).toBe("collaborate");
		expect(tool.promptSnippet).toBeUndefined();
		expect(tool.promptGuidelines).toBeUndefined();
		expect(tool.parameters.properties.action.anyOf.map((entry: any) => entry.properties.name.const))
			.toEqual(["inspect", "claim", "report"]);
		expect(tool.description).toContain("available through codeteam");
	});
	test("self-authored claims, skeptical evidence, and verification depth survive the organization move", () => {
		const agent = fs.readFileSync(path.join(root, "references/agent.md"), "utf8");
		for (const expression of [
			/Claim records work responsibility, not tool permission/,
			/Inspect enough to identify a sound work boundary/,
			/need not solve the issue before claiming investigation work/,
			/Do not narrow the Commitment around\s+a material technical assumption/,
			/exact technical boundary[\s\S]*relevant consumers and variants/,
			/independent\s+observations, cross-checks, and attempts to disconfirm/,
			/repetition or deference\s+alone is not consensus/,
			/framework or configuration metadata[\s\S]*every relevant consumer/,
			/Vary metadata-selected\s+behavior across supported configurations/,
		]) expect(agent).toMatch(expression);
	});
	test("Pi retains codeteam while semantic reporting remains a three-action tool", () => {
		const agent = fs.readFileSync(path.join(root, "references/agent.md"), "utf8");
		for (const expression of [
			/You are a Pi executor working inside one assigned Goal/,
			/codeteam.*available through bash/,
			/does not restrict commands based\s+on whether the caller is Pi/,
			/no delegate, message, follow-up, or wait action/,
			/prior session may be\s+reused for an outer follow-up/,
			/continue it instead of claiming a replacement/,
			/Use inspect to recall full Goals, Commitments, or\s+Receipts/,
			/your Receipt closes only your Commitment, not the Task/,
			/explicitly finishes the Task/,
		]) expect(agent).toMatch(expression);
		expect(agent).not.toMatch(/Do not create or launch other Agents|keeps any Parent alive|Child feedback|every depth|Root Agent owns/);
	});
	test("completed reports describe a finished contribution and preserve remaining work", () => {
		const agent = fs.readFileSync(path.join(root, "references/agent.md"), "utf8");
		expect(agent).toMatch(/completed` Receipt\s+ends your contribution and may include remaining work/);
		expect(agent).toMatch(/record unfinished\s+work in `remaining`/);
		expect(agent).toMatch(/Under\s+context pressure, leave this report while enough context remains/);
		expect(agent).not.toMatch(/widen work or evidence coverage before closing/);
		const tools: any[] = [];
		organization({ on() {}, registerTool(value: unknown) { tools.push(value); } } as never);
		const report = tools[0].parameters.properties.action.anyOf.find((entry: any) => entry.properties.name.const === "report");
		expect(report.description).toContain("A completed report may include remaining work");
		for (const entry of ["runtime/cli/run.ts", "runtime/cli/team-runner.ts"]) {
			const source = fs.readFileSync(path.join(root, entry), "utf8");
			expect(source).toContain("report your contribution and any remaining work before ending this execution");
			expect(source).not.toContain("continue it to closure");
		}
	});
});
