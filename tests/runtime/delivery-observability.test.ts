import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGoal } from "../../runtime/lib/goals";
import { openHandoff, submitReceipt } from "../../runtime/lib/handoff";
import { projectHandoffState } from "../../runtime/lib/observability/handoff-state";
import { summarizeHandoffStates } from "../../runtime/lib/observability/summary";
import { RunPaths } from "../../runtime/lib/paths";
import { createTask } from "../../runtime/lib/tasks";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function runtime(): RunPaths {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-obligations-"));
	dirs.push(root);
	const paths = new RunPaths(path.join(root, "runs"), "task-obligations");
	createTask(paths, "observe declarations");
	fs.mkdirSync(paths.evidence, { recursive: true });
	return paths;
}

function rootReceipt(paths: RunPaths, decisions: string[], effects: Array<{ file: string }> = []) {
	const handoff = openHandoff(paths, { goalId: paths.runId, digest: "root", intent: "root", expectedOutcome: ["done"] });
	submitReceipt(paths, { handoffId: handoff.id, status: "completed", decisions, effects });
	return handoff;
}

describe("verified declaration projection", () => {
	test("projects valid declarations, applicability nulls, and aggregate denominators", () => {
		const paths = runtime();
		const proof = path.join(paths.evidence, "proof.json");
		fs.writeFileSync(proof, "{}\n");
		const root = rootReceipt(paths, [
			"decomposition: split — independent outcome",
			`obligation.regression: met — ${proof}`,
			"obligation.reproduction: exempt — no defect",
			"obligation.consumers: met — src/api.ts:load, src/ui.ts:render",
		], [{ file: proof }]);
		createGoal(paths, { id: "child", objective: "child" });
		const child = openHandoff(paths, {
			goalId: "child",
			digest: "child",
			intent: "child",
			expectedOutcome: ["done"],
			parentHandoffId: root.id,
		});
		submitReceipt(paths, { handoffId: child.id, status: "blocked", blockers: ["external"] });

		const rootState = projectHandoffState(paths, root.id);
		expect(rootState).toMatchObject({
			decomposition: "split",
			decomposition_mismatch: false,
			has_direct_child: true,
			obligation_regression: "met",
			obligation_reproduction: "exempt",
			obligation_consumers: "met",
		});
		expect(JSON.stringify(rootState)).not.toContain(proof);
		const childState = projectHandoffState(paths, child.id);
		expect(childState).toMatchObject({
			decomposition: null,
			decomposition_mismatch: null,
			obligation_regression: null,
			obligation_reproduction: null,
			obligation_consumers: null,
		});
		const summary = summarizeHandoffStates([rootState, childState], true);
		expect(summary.decomposition).toMatchObject({ eligible: 1, split: 1, mismatch: 0 });
		expect(summary.obligations.regression).toMatchObject({ eligible: 1, met: 1, missing: 0 });
	});

	test("missing, malformed, duplicate, and case-insensitive lines have deterministic states", () => {
		const paths = runtime();
		const root = rootReceipt(paths, [
			"DECOMPOSITION: SOLO — bounded work",
			"obligation.reproduction: exempt — none",
			"OBLIGATION.REPRODUCTION: exempt — duplicate",
			"obligation.consumers: met — not-a-consumer-reference",
		]);
		expect(projectHandoffState(paths, root.id)).toMatchObject({
			decomposition: "solo",
			obligation_regression: "missing",
			obligation_reproduction: "malformed",
			obligation_consumers: "malformed",
		});
	});

	test("evidence refs require an absolute, existing regular file inside the canonical evidence root", () => {
		const cases: Array<{ name: string; prepare: (paths: RunPaths) => string; expected: "met" | "malformed"; includeEffect?: boolean }> = [
			{
				name: "valid",
				prepare(paths) { const file = path.join(paths.evidence, "valid.log"); fs.writeFileSync(file, "ok"); return file; },
				expected: "met",
			},
			{
				name: "missing effect",
				prepare(paths) { const file = path.join(paths.evidence, "no-effect.log"); fs.writeFileSync(file, "ok"); return file; },
				expected: "malformed",
				includeEffect: false,
			},
			{
				name: "nonexistent",
				prepare(paths) { return path.join(paths.evidence, "missing.log"); },
				expected: "malformed",
			},
			{
				name: "directory",
				prepare(paths) { const file = path.join(paths.evidence, "directory"); fs.mkdirSync(file); return file; },
				expected: "malformed",
			},
			{
				name: "outside",
				prepare(paths) { const file = path.join(path.dirname(paths.evidence), "outside.log"); fs.writeFileSync(file, "no"); return file; },
				expected: "malformed",
			},
			{
				name: "traversal",
				prepare(paths) { fs.mkdirSync(path.join(paths.evidence, "sub")); fs.writeFileSync(path.join(paths.evidence, "proof.log"), "ok"); return `${paths.evidence}/sub/../proof.log`; },
				expected: "malformed",
			},
			{
				name: "symlink escape",
				prepare(paths) {
					const outside = path.join(path.dirname(paths.evidence), "outside-target.log");
					fs.writeFileSync(outside, "no");
					const link = path.join(paths.evidence, "link.log");
					fs.symlinkSync(outside, link);
					return link;
				},
				expected: "malformed",
			},
		];
		for (const entry of cases) {
			const paths = runtime();
			const reference = entry.prepare(paths);
			const root = rootReceipt(paths, [
				"decomposition: solo — bounded",
				`obligation.regression: met — ${reference}`,
				"obligation.reproduction: exempt — none",
				"obligation.consumers: exempt — no interface change",
			], entry.includeEffect === false ? [] : [{ file: reference }]);
			expect(projectHandoffState(paths, root.id).obligation_regression, entry.name).toBe(entry.expected);
		}
	});

	test("mismatch uses direct parent_handoff_id only", () => {
		const paths = runtime();
		const root = rootReceipt(paths, [
			"decomposition: split — delegated",
			"obligation.regression: exempt — none",
			"obligation.reproduction: exempt — none",
			"obligation.consumers: exempt — none",
		]);
		const unrelated = openHandoff(paths, { goalId: paths.runId, digest: "other", intent: "other", expectedOutcome: ["done"] });
		openHandoff(paths, { goalId: paths.runId, digest: "grandchild", intent: "nested", expectedOutcome: ["done"], parentHandoffId: unrelated.id });
		expect(projectHandoffState(paths, root.id).decomposition_mismatch).toBe(true);
		openHandoff(paths, { goalId: paths.runId, digest: "direct", intent: "direct", expectedOutcome: ["done"], parentHandoffId: root.id });
		expect(projectHandoffState(paths, root.id).decomposition_mismatch).toBe(false);
	});
});
