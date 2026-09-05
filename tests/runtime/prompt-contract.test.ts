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


describe("Unified Agent prompt contracts", () => {
	test("the shared prompt is the configured Agent contract and runtime context remains pull-first", () => {
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
		const context = buildWorkerContext(paths, paths.runId, commitment);
		expect(context.sources.map((source) => source.kind)).toEqual(["goal", "current_commitment", "current_commitment_folded"]);
		const agents = fs.readFileSync(path.join(root, "runtime/AGENTS.md"), "utf8");
		expect(agents).toContain(`../${config.agent.prompt}`);
	});

	test("Root and Child receive identical four-action metadata without hidden prompt fragments", () => {
		const previousKind = process.env.CODEFLOW_PROCESS_KIND;
		const tools: any[] = [];
		try {
			for (const kind of ["root", "child"]) {
				process.env.CODEFLOW_PROCESS_KIND = kind;
				organization({ on() {}, registerTool(value: unknown) { tools.push(value); } } as never);
			}
		} finally {
			if (previousKind === undefined) delete process.env.CODEFLOW_PROCESS_KIND;
			else process.env.CODEFLOW_PROCESS_KIND = previousKind;
		}
		for (const tool of tools) {
			expect(tool.name).toBe("collaborate");
			expect(tool.promptSnippet).toBeUndefined();
			expect(tool.promptGuidelines).toBeUndefined();
			expect(tool.parameters.properties.action.anyOf.map((entry: any) => entry.properties.name.const))
				.toEqual(["inspect", "claim", "report", "delegate"]);
		}
		expect(tools[0].parameters).toEqual(tools[1].parameters);
		expect(tools[0].description).toBe(tools[1].description);
	});

	test("unified authority preserves self-authored claims and disconfirming verification", () => {
		const agent = fs.readFileSync(path.join(root, "references/agent.md"), "utf8");
		expect(agent).toMatch(/Until the Claim succeeds, restrict tools to read-only repository inspection/);
		expect(agent).toMatch(/effects, and delegation require an open Commitment/);
		expect(agent).toMatch(/does not prescribe the Child's Commitment, implementation, or\s+verification/);
		expect(agent).toMatch(/under 600 characters as one concise, coherent statement/);
		expect(agent).toMatch(/Do not narrow the Commitment around\s+a material technical assumption/);
		expect(agent).toMatch(/exact technical boundary[\s\S]*relevant consumers and variants/);
		expect(agent).toMatch(/independent\s+observations, cross-checks, and attempts to disconfirm/);
		expect(agent).toMatch(/repetition or deference\s+alone is not consensus/);
		expect(agent).toMatch(/framework or configuration metadata[\s\S]*every relevant consumer/);
		expect(agent).toMatch(/Vary metadata-selected\s+behavior across supported configurations/);
	});

	test("proactive delegation applies throughout execution without forcing unnecessary Children", () => {
		const agent = fs.readFileSync(path.join(root, "references/agent.md"), "utf8");
		expect(agent).toMatch(/At any point, proactively delegate bounded, independent work/);
		expect(agent).toMatch(/every Agent, including Children/);
		expect(agent).toMatch(/your own useful critical-path work while Children work/);
		expect(agent).toMatch(/keep concurrent write boundaries disjoint/);
		expect(agent).toMatch(/may be completed locally without creating a Child/);
		expect(agent).toMatch(/A Goal may be\s+delegated again/);
		expect(agent).toMatch(/Choose independent checks when the risk or unresolved uncertainty justifies them/);
		expect(agent).toMatch(/do not poll or assume the failed delegation was queued/);
	});

	test("every Parent reconciles descendants while leaves may finish and idle responses yield", () => {
		const agent = fs.readFileSync(path.join(root, "references/agent.md"), "utf8");
		expect(agent).toMatch(/Delegation is asynchronous/);
		expect(agent).toMatch(/keeps any Parent alive while its Children run and continues it on new feedback/);
		expect(agent).toMatch(/ending a response does not complete a Commitment or the Task/);
		expect(agent).toMatch(/Do not poll or\s+block on a Child/);
		expect(agent).toMatch(/An Agent without Children may complete its own work directly/);
		expect(agent).toMatch(/all delegated executions and descendant Commitments must have ended first/);
		expect(agent).toMatch(/Do not rewrite the Child's Commitment/);
		expect(agent).toMatch(/Child Receipts do not close the Task by themselves/);
	});
});
