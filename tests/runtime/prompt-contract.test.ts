import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { contentHash } from "../../runtime/lib/canonical";
import { buildWorkerContext } from "../../runtime/extensions/codeflow-context/context";
import { openHandoff, submitReceipt } from "../../runtime/lib/handoff";
import { RunPaths } from "../../runtime/lib/paths";
import { createTask } from "../../runtime/lib/tasks";

const root = path.resolve(import.meta.dir, "../..");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("Design G prompt contract", () => {
	test("shared rules carry normalized obligations and decomposition without protocol gating", () => {
		const rules = fs.readFileSync(path.join(root, "runtime/AGENTS.md"), "utf8");
		for (const key of ["regression", "reproduction", "consumers"]) {
			expect(rules).toContain(`obligation.${key}:`);
		}
		expect(rules).toContain("decomposition: split | solo — <reason>");
		expect(rules).toContain("offline reporting");
		expect(rules).toContain("does not reject or change a status");

		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-prompt-"));
		dirs.push(temp);
		const paths = new RunPaths(path.join(temp, "runs"), "task-prompt");
		createTask(paths, "verify prompt");
		const handoff = openHandoff(paths, { goalId: paths.runId, digest: "prompt", intent: "verify", expectedOutcome: ["verified"] });
		const context = buildWorkerContext(paths, handoff, { sharedRules: rules });
		expect(context.sources).toContainEqual({ kind: "shared_rules", ref: "runtime/AGENTS.md", hash: contentHash(rules) });
	});

	test("prompt files contain no retired identity, preference, or prescribed-flow vocabulary", () => {
		const agents = fs.readFileSync(path.join(root, "runtime/AGENTS.md"), "utf8");
		const worker = fs.readFileSync(path.join(root, "references/worker.md"), "utf8");
		for (const text of [agents, worker]) {
			expect(text).not.toMatch(/\b(?:depth|thread|acceptance_context|roles)\b/i);
		}
		expect(worker).not.toMatch(/\b(?:should|prefer|consider)\b/i);
		const obligations = agents.slice(agents.indexOf("## Delivery obligations"));
		expect(obligations).not.toMatch(/\b(?:first|then|before you|step)\b/i);
	});

	test("Receipt submission remains independent of declaration validity", () => {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-prompt-"));
		dirs.push(temp);
		const paths = new RunPaths(path.join(temp, "runs"), "task-receipt");
		createTask(paths, "accept semantic result");
		const empty = openHandoff(paths, { goalId: paths.runId, digest: "empty", intent: "empty", expectedOutcome: ["done"] });
		expect(submitReceipt(paths, { handoffId: empty.id, status: "completed" }).status).toBe("completed");
		const malformed = openHandoff(paths, { goalId: paths.runId, digest: "malformed", intent: "malformed", expectedOutcome: ["done"] });
		expect(submitReceipt(paths, {
			handoffId: malformed.id,
			status: "completed",
			decisions: ["obligation.regression: nonsense", "decomposition: unknown"],
		}).status).toBe("completed");
	});

	test("worker text explicitly keeps closure with the delegating Worker", () => {
		const worker = fs.readFileSync(path.join(root, "references/worker.md"), "utf8");
		expect(worker).toContain("handing off the remainder of an underway");
		expect(worker).toContain("delegating Worker still awaits the outcome");
		expect(worker).toContain("closes its own");
	});
});
