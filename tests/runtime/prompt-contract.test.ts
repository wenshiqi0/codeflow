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


describe("Manager and Worker prompt contracts", () => {
	test("the Worker prompt teaches the durable collaboration nouns and repository methods", () => {
		const worker = fs.readFileSync(path.join(root, "references/worker.md"), "utf8");
		for (const noun of ["Goal", "Commitment", "Receipt", "Worker"]) expect(worker).toContain(noun);
		expect(worker).not.toMatch(/obligation\.|decomposition:|claim_revision|invariant|falsification|recall level|superseded|partial Receipt|failed Receipt/i);
		expect(worker).toContain("Test-driven development");
		expect(worker).toContain("Challenge them when evidence exposes an");
		expect(worker).toMatch(/independent\s+observations, cross-checks, and attempts to disconfirm/);
		expect(worker).toMatch(/repetition or deference\s+alone is not consensus/);
		expect(worker).toMatch(/Until the Claim succeeds, restrict\s+tools to read-only repository inspection/);
		expect(worker).toContain("Do not narrow the Commitment around a material technical assumption");
		expect(worker).toMatch(/exact technical boundary[\s\S]*relevant consumers and variants/);
		expect(worker).toMatch(/framework or configuration metadata[\s\S]*every relevant consumer/);
		expect(worker).toMatch(/variant that changes the metadata-selected[\s\S]*non-primary or aliased key/);
		expect(worker).not.toContain("delegate");

		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-prompt-"));
		dirs.push(temp);
		const paths = new RunPaths(path.join(temp, "runs"), "task-prompt");
		createTask(paths, "verify prompt");
		const commitment = claimTestWork(paths, { goalId: paths.runId, work: "verify the prompt" });
		const context = buildWorkerContext(paths, paths.runId, commitment);
		expect(context.sources.map((source) => source.kind)).toEqual(["goal", "current_commitment", "current_commitment_folded"]);
		const agents = fs.readFileSync(path.join(root, "runtime/AGENTS.md"), "utf8");
		expect(agents).toContain("../references/manager.md");
		expect(agents).toContain("../references/worker.md");
	});

	test("Root tool metadata locks the five actions without hidden prompt fragments", () => {
		let tool: any;
		process.env.CODEFLOW_PROCESS_KIND = "root";
		organization({ registerTool(value: unknown) { tool = value; } } as never);
		delete process.env.CODEFLOW_PROCESS_KIND;
		expect(tool.name).toBe("collaborate");
		expect(tool.promptSnippet).toBeUndefined();
		expect(tool.promptGuidelines).toBeUndefined();
		expect(tool.parameters.properties.action.anyOf.map((entry: any) => entry.properties.name.const))
			.toEqual(["inspect", "claim", "report", "delegate", "wait"]);
		expect(JSON.stringify(tool.parameters)).not.toMatch(/get_goal|get_commitment|get_receipt|claim_work|append_receipt|report_issue|spawn_worker/);
	});

	test("Manager knowledge stays separate from Worker implementation methods", () => {
		const manager = fs.readFileSync(path.join(root, "references/manager.md"), "utf8");
		const worker = fs.readFileSync(path.join(root, "references/worker.md"), "utf8");
		for (const pattern of ["Direct implementation", "Diagnosis before repair", "Test-driven development", "Characterization", "Benchmark-driven change", "Risk-based verification"]) {
			expect(worker).toContain(pattern);
		}
		expect(manager).toContain("The Task is the root Goal");
		expect(manager).toMatch(/A Goal may be\s+delegated again/);
		expect(manager).toContain("Your responsibility is coordination rather than implementation");
		expect(manager).toContain("it does not prescribe the Worker's Commitment, implementation, or");
		expect(manager).toContain("under 600 characters as one concise, coherent statement");
		expect(manager).toContain("instead of packing it with implementation steps or");
		expect(manager).toContain("Worker feedback may change the organization");
		expect(manager).toContain("Delegation is asynchronous");
		expect(manager).toContain("instead of immediately waiting on it");
		expect(manager).toContain("`wait` is not an idle fallback");
		expect(manager).toMatch(/strong dependency on a Worker result/);
		expect(manager).toMatch(/cannot proceed without that\s+result/);
		expect(manager).toContain("A Child Claim is early asynchronous feedback, not an approval gate");
		expect(manager).toContain("inspect its Commitment");
		expect(manager).toContain("prematurely treats a material technical assumption as");
		expect(manager).toContain("delegate an independent cross-check");
		expect(manager).toContain("Inspection alone does not adjust coverage");
		expect(manager).toMatch(/After finding a narrow\s+boundary, do not repeat `wait` or close the Task/);
		expect(manager).toMatch(/Do not rewrite the Child's\s+Commitment/);
		expect(manager).not.toContain("no useful coordination action remains");
		expect(manager).not.toContain("Test-driven development");
		expect(manager).not.toMatch(/decomposition:|obligation\.|claim_revision|invariant|falsification/i);
	});

	test("Manager stewardship details do not leak into the Worker prompt", () => {
		const worker = fs.readFileSync(path.join(root, "references/worker.md"), "utf8");
		for (const phrase of ["unassigned work", "integrate Worker results", "decide when the Task is complete"]) {
			expect(worker).not.toContain(phrase);
		}
	});
});
