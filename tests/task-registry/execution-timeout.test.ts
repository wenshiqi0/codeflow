/**
 * Executable product contract: a timed-out delegation returns control to the
 * root planner as a structured, terminal pointer.
 *
 * SSOT for reconciling a delegated child whose verification command exceeded
 * an execution timeout (red-first). The current reconciler only recognizes
 * the stream-idle marker, so a child aborted by the bash watchdog is
 * classified as a generic provider failure or an unexplained missing
 * artifact. This contract pins:
 *
 * 1. A child whose stderr carries the bash-timeout marker finishes BLOCKED
 *    with reasons ["EXECUTION_TIMEOUT", "DELEGATION_ARTIFACT_MISSING"]
 *    (cause first), and the blocked handoff_finished event carries the same
 *    EXECUTION_TIMEOUT reason — which requires the closed event-reason enum
 *    to contain it.
 * 2. The delegator receives a structured delegation pointer (never a
 *    receipt body, never prose) so the root planner — and only the planner —
 *    decides whether to split the command, change the timeout/environment,
 *    or redelegate.
 * 3. No implicit retry: the blocked handoff is terminal and immutable, and
 *    cannot be restarted by a second reconciliation. A retry is an explicit
 *    new handoff authored by the planner.
 *
 * Runner: bun test tests/task-registry/execution-timeout.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { finishHandoff, openHandoff, startHandoff } from "../../runtime/lib/handoff";
import { RunPaths } from "../../runtime/lib/paths";
import { delegationPointer } from "../../runtime/extensions/codeflow-task/handoff-gate";
import { reconcileHandoff } from "../../runtime/extensions/codeflow-task/registry";
import type { RoleRunResult } from "../../runtime/extensions/codeflow-task/shared";

let project: string;
let paths: RunPaths;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-timeout-reconcile-"));
	process.chdir(project);
	paths = new RunPaths(".codeflow/runs/code", "run-timeout-reconcile-test");
	for (const key of ["CODEFLOW_RUN_ID", "CODEFLOW_RUNS_DIR", "CODEFLOW_AGENT_ROLE", "CODEFLOW_AGENT_DEPTH"]) {
		savedEnv[key] = process.env[key];
	}
	process.env.CODEFLOW_RUN_ID = paths.runId;
	process.env.CODEFLOW_RUNS_DIR = paths.code;
	process.env.CODEFLOW_AGENT_ROLE = "planner";
	process.env.CODEFLOW_AGENT_DEPTH = "0";
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	const cwd = process.cwd();
	process.chdir(path.dirname(cwd));
	fs.rmSync(project, { recursive: true, force: true });
});

/**
 * What the launcher observes when the agent-watchdog's bash guard aborts a
 * child turn: the marker line on stderr, a nonzero exit from the aborted
 * turn, and no receipt (the role never regained control to finish).
 */
function timedOutChild(): RoleRunResult {
	return {
		agent: "verify",
		success: false,
		content: "",
		exitCode: 1,
		stopReason: "aborted",
		errorMessage: undefined,
		stderr:
			"[agent-watchdog] bash timeout toolu_01 exceeded 900000ms " +
			"(set CODEFLOW_BASH_TIMEOUT_MS=0 to disable); aborting tool execution\n",
	};
}

function openedVerifyHandoff() {
	return openHandoff(paths, {
		role: "verify",
		body: "Goal: run the named checks\n",
		depth: 1,
	});
}

function readEventBodies(): Record<string, unknown>[] {
	if (!fs.existsSync(paths.events)) return [];
	return fs
		.readdirSync(paths.events)
		.filter((name) => name.endsWith(".json"))
		.map((name) => JSON.parse(fs.readFileSync(path.join(paths.events, name), "utf8")));
}

describe("timed-out delegation reconciliation contract", () => {
	test("a bash-timeout child finishes BLOCKED with EXECUTION_TIMEOUT first, and the event carries the reason", () => {
		const opened = openedVerifyHandoff();
		const reconciled = reconcileHandoff(
			{
				handoffId: opened.handoff_id,
				statePath: paths.statePath(opened.handoff_id),
				receiptPath: paths.receiptPath(opened.handoff_id),
			},
			timedOutChild(),
			project,
		);

		expect(reconciled.status).toBe("BLOCKED");
		expect(reconciled.reasons).toEqual(["EXECUTION_TIMEOUT", "DELEGATION_ARTIFACT_MISSING"]);

		const state = JSON.parse(fs.readFileSync(paths.statePath(opened.handoff_id), "utf8")) as {
			status: string;
			blocked?: { reason?: string; reasons?: string[] };
		};
		expect(state.status).toBe("blocked");
		expect(state.blocked?.reasons).toEqual(["EXECUTION_TIMEOUT", "DELEGATION_ARTIFACT_MISSING"]);

		// The event plane must accept the new reason (closed enum) so the
		// outer loop observes the actual cause, not provider prose.
		const finished = readEventBodies().filter(
			(body) => body.kind === "handoff_finished" && body.status === "BLOCKED",
		);
		expect(finished.length).toBeGreaterThan(0);
		expect(
			finished.some((body) => (body.reasons as string[])?.includes("EXECUTION_TIMEOUT")),
		).toBe(true);
	});

	test("the delegator gets a structured pointer; only the planner decides what happens next", () => {
		const opened = openedVerifyHandoff();
		const reconciled = reconcileHandoff(
			{
				handoffId: opened.handoff_id,
				statePath: paths.statePath(opened.handoff_id),
				receiptPath: paths.receiptPath(opened.handoff_id),
			},
			timedOutChild(),
			project,
		);

		// Exactly the pointer the task tool returns to the planner: ids and
		// paths, never the receipt body, in the fixed key order.
		const pointer = delegationPointer(
			opened.handoff_id,
			reconciled.status,
			reconciled.reasons,
			reconciled.receipt,
			paths.statePath(opened.handoff_id),
		);
		expect(JSON.parse(JSON.stringify(pointer))).toEqual({
			handoff_id: opened.handoff_id,
			status: "BLOCKED",
			reasons: ["EXECUTION_TIMEOUT", "DELEGATION_ARTIFACT_MISSING"],
			receipt: null,
			state: paths.statePath(opened.handoff_id),
		});
	});

	test("no implicit retry: the blocked handoff is terminal and cannot be restarted", () => {
		const opened = openedVerifyHandoff();
		const handoff = {
			handoffId: opened.handoff_id,
			statePath: paths.statePath(opened.handoff_id),
			receiptPath: paths.receiptPath(opened.handoff_id),
		};

		const first = reconcileHandoff(handoff, timedOutChild(), project);
		expect(first.status).toBe("BLOCKED");

		// A second reconciliation of the same terminal child changes nothing:
		// no reopen, no retry, no rewritten reasons.
		const second = reconcileHandoff(handoff, timedOutChild(), project);
		expect(second.status).toBe("BLOCKED");
		expect(second.reasons).toEqual(["EXECUTION_TIMEOUT", "DELEGATION_ARTIFACT_MISSING"]);

		// The state machine enforces the same: a blocked handoff cannot be
		// restarted, and a terminal finish is rejected as illegal.
		expect(() => startHandoff(paths, opened.handoff_id)).toThrow();
		expect(() =>
			finishHandoff(paths, {
				handoffId: opened.handoff_id,
				status: "PASS",
				summary: "second attempt",
				receipt: (() => {
					fs.writeFileSync("r.json", JSON.stringify({ status: "PASS" }));
					return "r.json";
				})(),
			}),
		).toThrow();
	});

	test("a self-finished BLOCKED(EXECUTION_TIMEOUT) child is reported, never rewritten", () => {
		// The role regained control (the evidence recorder returned 124),
		// finished its own handoff BLOCKED with the timeout reason, and left
		// command evidence behind. Reconciliation reports that verdict; it
		// must not reclassify or duplicate it.
		const opened = openedVerifyHandoff();
		finishHandoff(paths, {
			handoffId: opened.handoff_id,
			status: "BLOCKED",
			summary: "verification command exceeded the timeout",
			blockedReasons: ["EXECUTION_TIMEOUT"],
			detail: "code-agent evidence run returned 124 after the per-command timeout",
		});

		const reconciled = reconcileHandoff(
			{
				handoffId: opened.handoff_id,
				statePath: paths.statePath(opened.handoff_id),
				receiptPath: paths.receiptPath(opened.handoff_id),
			},
			{ ...timedOutChild(), exitCode: 0, stopReason: undefined, stderr: "" },
			project,
		);
		expect(reconciled.status).toBe("BLOCKED");
		expect(reconciled.reasons).toEqual(["EXECUTION_TIMEOUT"]);
		const state = JSON.parse(fs.readFileSync(paths.statePath(opened.handoff_id), "utf8")) as {
			blocked?: { reasons?: string[] };
		};
		expect(state.blocked?.reasons).toEqual(["EXECUTION_TIMEOUT"]);
	});
});
