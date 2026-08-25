import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	hasDurableProgress,
	loadReceipt,
	loadReceiptChain,
	openHandoff,
	startHandoff,
	submitReceipt,
} from "../../runtime/lib/handoff";
import { RunPaths } from "../../runtime/lib/paths";
import { scan } from "../../runtime/lib/wait";
import { goalState } from "../../runtime/lib/state";
import { recallHandoff, recallReceipt, recallGoal } from "../../runtime/lib/recall";
import { createTask } from "../../runtime/lib/tasks";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function runtime(): RunPaths {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-receipt-chain-"));
	dirs.push(root);
	const paths = new RunPaths(path.join(root, "runs"), "task-chain");
	createTask(paths, "chain work");
	return paths;
}

describe("multi-Receipt Handoff semantics", () => {
	test("progress Receipts append immutably and keep the Handoff open", () => {
		const paths = runtime();
		const handoff = openHandoff(paths, { goalId: paths.runId, digest: "work", intent: "work", expectedOutcome: ["done"] });
		startHandoff(paths, handoff.id);
		const first = submitReceipt(paths, { handoffId: handoff.id, status: "progress", established: ["fact one"], unresolved: ["question"] });
		const folded = loadReceiptChain(paths, handoff.id);
		expect(folded.receipts).toHaveLength(1);
		expect(folded.terminal).toBeNull();
		expect(folded.established).toEqual(["fact one"]);
		expect(hasDurableProgress(folded)).toBe(true);
		expect(folded.unresolved).toEqual(["question"]);
		// Chain storage: append-only under receipts/, not the legacy file.
		expect(fs.readdirSync(paths.receiptDir(handoff.id))).toHaveLength(1);
		expect(fs.existsSync(paths.receiptPath(handoff.id))).toBe(false);
		expect(first.id).toMatch(/^r_[0-9a-f]{64}$/);
		const second = submitReceipt(paths, { handoffId: handoff.id, status: "completed", established: ["closed"] });
		const closed = loadReceiptChain(paths, handoff.id);
		expect(closed.receipts).toHaveLength(2);
		expect(closed.terminal?.id).toBe(second.id);
		expect(closed.head?.id).toBe(second.id);
		// Terminal closure rejects further Receipts.
		expect(() => submitReceipt(paths, { handoffId: handoff.id, status: "progress" })).toThrow(/already closed/);
		// Active sentinel removed only by the terminal Receipt.
		expect(fs.existsSync(path.join(paths.active, `${handoff.id}.json`))).toBe(false);
	});

	test("resolution references drop stale facts deterministically", () => {
		const paths = runtime();
		const handoff = openHandoff(paths, { goalId: paths.runId, digest: "work", intent: "work", expectedOutcome: ["done"] });
		submitReceipt(paths, { handoffId: handoff.id, status: "progress", unresolved: ["question"], blockers: ["blocked on x"], decisions: ["old decision"] });
		submitReceipt(paths, {
			handoffId: handoff.id,
			status: "progress",
			resolved: ["old decision"],
			resolvedUnresolved: ["question"],
			resolvedBlockers: ["blocked on x"],
			established: ["moved on"],
		});
		const folded = loadReceiptChain(paths, handoff.id);
		expect(folded.unresolved).toEqual([]);
		expect(folded.blockers).toEqual([]);
		expect(folded.decisions).toEqual([]);
		expect(folded.established).toEqual(["moved on"]);
		// Unknown references fail loudly instead of silently accumulating.
		expect(() => submitReceipt(paths, { handoffId: handoff.id, status: "progress", resolved: ["ghost"] })).toThrow(/unknown fact/);
	});

	test("a later Handoff resolves earlier Goal semantics", () => {
		const paths = runtime();
		const first = openHandoff(paths, { goalId: paths.runId, digest: "investigate", intent: "investigate", expectedOutcome: ["finding"] });
		submitReceipt(paths, {
			handoffId: first.id,
			status: "partial",
			decisions: ["temporary choice"],
			unresolved: ["open question"],
			blockers: ["waiting on evidence"],
		});
		const second = openHandoff(paths, { goalId: paths.runId, digest: "resolve", intent: "resolve", expectedOutcome: ["closed"] });
		submitReceipt(paths, {
			handoffId: second.id,
			status: "completed",
			resolved: ["temporary choice"],
			resolvedUnresolved: ["open question"],
			resolvedBlockers: ["waiting on evidence"],
			decisions: ["final choice"],
		});
		const state = goalState(paths, paths.runId);
		expect(state.status).toBe("completed");
		expect(state.decisions).toEqual(["final choice"]);
		expect(state.unresolved).toEqual([]);
		expect(state.blockers).toEqual([]);
	});

	test("events and goal state distinguish progress from terminal closure", () => {
		const paths = runtime();
		const handoff = openHandoff(paths, { goalId: paths.runId, digest: "work", intent: "work", expectedOutcome: ["done"] });
		submitReceipt(paths, { handoffId: handoff.id, status: "progress", established: ["finding"] });
		let events = scan(paths.events, 0, ["receipt_submitted", "run_finished"]).events;
		expect(events.map((event) => event.status)).toEqual(["PROGRESS"]);
		expect(goalState(paths, paths.runId).status).toBe("active");
		submitReceipt(paths, { handoffId: handoff.id, status: "partial", established: ["done enough"] });
		events = scan(paths.events, 0, ["receipt_submitted", "run_finished"]).events;
		expect(events.map((event) => event.status)).toEqual(["PROGRESS", "PARTIAL", "PARTIAL"]);
		expect(goalState(paths, paths.runId).status).toBe("partial");
		expect(goalState(paths, paths.runId).established).toEqual(["finding", "done enough"]);
	});

	test("schema-v1 receipt.json reads as one terminal Receipt", () => {
		const paths = runtime();
		const handoff = openHandoff(paths, { goalId: paths.runId, digest: "legacy", intent: "legacy", expectedOutcome: ["done"] });
		const legacy = {
			schema_version: 1,
			seq: 1,
			task_id: paths.runId,
			goal_id: paths.runId,
			handoff_id: handoff.id,
			status: "completed",
			effects: [],
			established: ["legacy outcome"],
			decisions: [],
			discovered: [],
			unresolved: [],
			blockers: [],
		};
		const { canonicalJson } = require("../../runtime/lib/canonical");
		const { contentId } = require("../../runtime/lib/canonical");
		const id = contentId("r", legacy);
		fs.mkdirSync(paths.handoffDir(handoff.id), { recursive: true });
		fs.writeFileSync(paths.receiptPath(handoff.id), JSON.stringify({ id, ...legacy }, null, 2) + "\n");
		expect(loadReceipt(paths, handoff.id)?.id).toBe(id);
		const folded = loadReceiptChain(paths, handoff.id);
		expect(folded.legacy).toBe(true);
		expect(folded.terminal?.id).toBe(id);
		expect(folded.established).toEqual(["legacy outcome"]);
		// Chain writes after a legacy closure are refused.
		expect(() => submitReceipt(paths, { handoffId: handoff.id, status: "progress" })).toThrow(/already closed/);
	});

	test("recall supports Handoff and exact Receipt lookup with compact defaults", () => {
		const paths = runtime();
		const handoff = openHandoff(paths, { goalId: paths.runId, digest: "work", intent: "work", expectedOutcome: ["done"] });
		const first = submitReceipt(paths, { handoffId: handoff.id, status: "progress", established: ["one"] });
		const second = submitReceipt(paths, { handoffId: handoff.id, status: "completed", established: ["two"] });
		const handoffRecall = recallHandoff(paths, handoff.id, "state");
		expect(handoffRecall).toMatchObject({ level: "state", handoff_id: handoff.id });
		expect(handoffRecall.head).toMatchObject({ receipt_id: second.id, terminal: true, receipt_count: 2 });
		expect(handoffRecall).not.toHaveProperty("handoff");
		expect(recallHandoff(paths, handoff.id, "semantic")).toMatchObject({
			level: "semantic",
			handoff: { id: handoff.id },
			folded: { established: ["one", "two"] },
		});
		expect(recallHandoff(paths, handoff.id, "full")).toMatchObject({ receipts: [{ id: first.id }, { id: second.id }] });
		expect(recallReceipt(paths, first.id)?.id).toBe(first.id);
		expect(recallReceipt(paths, first.id, handoff.id)?.id).toBe(first.id);
		expect(recallReceipt(paths, "r_missing")).toBeNull();
		const semantic = recallGoal(paths, paths.runId, "semantic");
		expect(semantic).toMatchObject({
			level: "semantic",
			latest: {
				handoff: { id: handoff.id },
				head: { receipt_id: second.id, receipt_count: 2 },
				folded: { established: ["one", "two"] },
			},
		});
		expect(semantic).not.toHaveProperty("history");
		expect(recallGoal(paths, paths.runId, "full")).toMatchObject({
			history: [{ handoff: { id: handoff.id }, receipts: [{ id: first.id }, { id: second.id }] }],
		});
	});
});
