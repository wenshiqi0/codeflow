import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commitmentHistory, hasDurableProgress, loadReceiptChain, submitReceipt } from "../../runtime/lib/commitment";
import { RunPaths } from "../../runtime/lib/paths";
import { inspectCommitment, inspectGoal } from "../../runtime/lib/inspection";
import { goalState } from "../../runtime/lib/state";
import { createTask } from "../../runtime/lib/tasks";
import { scan } from "../../runtime/lib/wait";
import { claimTestWork } from "./helpers";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function runtime(): RunPaths {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-receipt-chain-"));
	dirs.push(root);
	const paths = new RunPaths(path.join(root, "runs"), "task-chain");
	createTask(paths, "chain work");
	return paths;
}

describe("concise Receipt chain", () => {
	test("history ignores unpublished Claim directories but still rejects corrupt published records", () => {
		const paths = runtime();
		const commitment = claimTestWork(paths, { goalId: paths.runId, work: "publish a Claim atomically" });
		const target = paths.commitmentPath(commitment.id);
		const staging = path.join(paths.commitmentDir(commitment.id), ".commitment.json.in-flight.tmp");
		fs.renameSync(target, staging);
		expect(commitmentHistory(paths)).toEqual([]);
		fs.renameSync(staging, target);
		expect(commitmentHistory(paths).map((view) => view.commitment.id)).toEqual([commitment.id]);
		fs.writeFileSync(target, "{corrupt");
		expect(() => commitmentHistory(paths)).toThrow();
	});

	test("progress appends and a terminal outcome closes the Commitment", () => {
		const paths = runtime();
		const commitment = claimTestWork(paths, { goalId: paths.runId, work: "repair behavior" });
		const first = submitReceipt(paths, {
			commitmentId: commitment.id,
			status: "progress",
			summary: "isolated the defect",
			effects: [{ file: "src/parser.ts" }],
			remaining: ["apply the repair"],
		});
		let folded = loadReceiptChain(paths, commitment.id);
		expect(folded.terminal).toBeNull();
		expect(folded.summaries).toEqual(["isolated the defect"]);
		expect(folded.remaining).toEqual(["apply the repair"]);
		expect(hasDurableProgress(folded)).toBe(true);
		const second = submitReceipt(paths, {
			commitmentId: commitment.id,
			status: "completed",
			summary: "repair verified",
			effects: [{ file: "src/parser.ts" }, { git: "abc123" }],
		});
		folded = loadReceiptChain(paths, commitment.id);
		expect(folded.terminal?.id).toBe(second.id);
		expect(folded.effects).toEqual([{ file: "src/parser.ts" }, { git: "abc123" }]);
		expect(folded.remaining).toEqual([]);
		expect(inspectCommitment(paths, commitment.id).receipts.map((receipt) => receipt.id)).toEqual([first.id, second.id]);
	});

	test("blocked requires remaining work; completed may record what remains", () => {
		const paths = runtime();
		const blocked = claimTestWork(paths, { goalId: paths.runId, work: "needs access" });
		expect(() => submitReceipt(paths, {
			commitmentId: blocked.id,
			status: "blocked",
			summary: "access missing",
		})).toThrow(/must explain what remains/);
		const completed = claimTestWork(paths, { goalId: paths.runId, work: "complete work" });
		const receipt = submitReceipt(paths, {
			commitmentId: completed.id,
			status: "completed",
			summary: "core work done",
			remaining: ["follow-up work remains for the outer caller"],
		});
		const folded = loadReceiptChain(paths, completed.id);
		expect(folded.terminal?.id).toBe(receipt.id);
		expect(folded.terminal?.status).toBe("completed");
		expect(folded.remaining).toEqual(["follow-up work remains for the outer caller"]);
		expect(commitmentHistory(paths).find((view) => view.commitment.id === completed.id)?.status).toBe("completed");
	});

	test("events and Goal inspection distinguish progress from closure", () => {
		const paths = runtime();
		const commitment = claimTestWork(paths, { goalId: paths.runId, work: "finish work" });
		submitReceipt(paths, { commitmentId: commitment.id, status: "progress", summary: "halfway" });
		expect(goalState(paths, paths.runId).status).toBe("active");
		submitReceipt(paths, { commitmentId: commitment.id, status: "completed", summary: "finished" });
		expect(scan(paths.events, 0, ["receipt_submitted", "run_finished"]).events.map((event) => event.status))
			.toEqual(["PROGRESS", "COMPLETED", "COMPLETED"]);
		expect(inspectGoal(paths, paths.runId)).toMatchObject({
			goal: { status: "completed", summaries: ["halfway", "finished"] },
			commitments: [{ receipt_count: 2, latest: { summary: "finished" } }],
		});
	});
});
