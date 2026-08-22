/**
 * Goal-aware handoff registration and reconciliation.
 */

import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import {
	BASH_TIMEOUT_ABORT_MARKER,
	blockedReasons,
	delegationPointer,
	MISSING_HANDOFF_FINISH_SUMMARY,
	STREAM_IDLE_ABORT_MARKER,
} from "./handoff-gate";
import { eventLogExcerpt } from "../../lib/events";
import {
	finishHandoff as finishHandoffState,
	handoffHistory,
	openHandoff as openHandoffState,
} from "../../lib/handoff";
import {
	type GoalContract,
	GoalError,
	THREAD_PATTERN,
	goalSessionId,
	loadGoal,
	UNGROUPED_GOAL_ID,
} from "../../lib/goals";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";
import type { RoleRunResult } from "./shared";

export { handoffHistory };


interface OpenedHandoff {
	handoffId: string;
	statePath: string;
	receiptPath: string;
	sessionId?: string;
}

/** Resolve the run paths for the run this process belongs to. */
function currentRun(): RunPaths | null {
	const runId = process.env.CODEFLOW_RUN_ID;
	if (!runId) return null;
	return new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, runId);
}

/**
 * Register the delegation as a handoff. Returns null when there is no run to
 * record against (for example `pi` started by hand), so delegation keeps
 * working without a registry rather than failing.
 */
export class TaskContractError extends Error {}

export interface GoalTaskRef {
	goalId: string;
	thread: string;
	contract: GoalContract | null;
	sessionId: string;
}

function freshThreadId(): string {
	return `t-${randomBytes(6).toString("hex")}`;
}

export function resolveGoalTask(
	goalId: string | undefined,
	thread: string | undefined,
): GoalTaskRef {
	if (thread !== undefined && !THREAD_PATTERN.test(thread)) {
		throw new TaskContractError(`invalid task thread: ${thread}`);
	}
	const paths = currentRun();
	if (!paths) throw new Error("cannot use a goal task outside a Codeflow run");
	const resolvedThread = thread ?? freshThreadId();
	if (!goalId) {
		return {
			goalId: UNGROUPED_GOAL_ID,
			thread: resolvedThread,
			contract: null,
			sessionId: goalSessionId(process.env.CODEFLOW_RUN_ID ?? "", UNGROUPED_GOAL_ID, resolvedThread),
		};
	}
	const contract = loadGoal(paths, goalId);
	return {
		goalId: contract.id,
		thread: resolvedThread,
		contract,
		sessionId: goalSessionId(process.env.CODEFLOW_RUN_ID ?? "", contract.id, resolvedThread),
	};
}

export function assertThreadAvailable(goal: GoalTaskRef): void {
	const paths = currentRun();
	if (!paths) return;
	const active = handoffHistory(paths).find(
		(state) =>
				state.goal_id === goal.goalId &&
				state.thread === goal.thread &&
				(state.status === "open" || state.status === "running"),
		);
	if (active) {
		throw new TaskContractError(
				`goal ${goal.goalId} thread ${goal.thread} already has active handoff ${active.handoff_id}`,
		);
	}
}

export function openHandoff(
	role: string,
	prompt: string,
	cwd: string,
	goal?: GoalTaskRef,
): OpenedHandoff | null {
	const paths = currentRun();
	if (!paths) return null;
	try {
		const opened = openHandoffState(paths, {
			role,
			body: prompt,
			depth: 1,
			parentId: process.env.CODEFLOW_HANDOFF_ID ?? null,
				...(goal
					? {
						goalId: goal.goalId === UNGROUPED_GOAL_ID ? undefined : goal.goalId,
						thread: goal.thread,
					}
					: {}),
		});
		return {
			handoffId: opened.handoff_id,
			statePath: opened.state,
			receiptPath: opened.receipt,
			sessionId: goal?.sessionId,
		};
	} catch {
		return null;
	}
}

export function readHandoffState(
	statePath: string,
): { status?: string; result?: string; blockedReasons?: string[] } {
	try {
		const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
		const blockedReasons = Array.isArray(state.blocked?.reasons)
			? state.blocked.reasons.filter((reason: unknown): reason is string => typeof reason === "string")
			: typeof state.blocked?.reason === "string"
				? [state.blocked.reason]
				: undefined;
		return { status: state.status, result: state.result, blockedReasons };
	} catch {
		return {};
	}
}

export function finishBlocked(
	handoffId: string,
	reasons: string[],
	detail: string,
	cwd: string,
	summary = MISSING_HANDOFF_FINISH_SUMMARY,
): void {
	const paths = currentRun();
	if (!paths) return;
	try {
		finishHandoffState(paths, {
			handoffId,
			status: "BLOCKED",
			summary,
			blockedReasons: reasons,
			detail,
		});
	} catch {
		// A handoff the child already finished is terminal and immutable; the
		// rejection is expected and must not mask the child's own verdict.
	}
}

/**
 * Reconcile what the child left behind with what the contract requires.
 *
 * Receipt *schema* validation already happened inside the CLI when the child
 * wrote it, so there is exactly one implementation of the schema; here the
 * check is existence. A handoff the child already finished is terminal and
 * immutable — the parent reports it and never rewrites it.
 */
export function reconcileHandoff(
	handoff: OpenedHandoff,
	result: RoleRunResult,
	cwd: string,
): { status: string; reasons: string[]; receipt: string | null } {
	const receiptPresent = fs.existsSync(handoff.receiptPath);
	const reasons = blockedReasons({
		exitCode: result.exitCode,
		stopReason: result.stopReason,
		aborted: result.aborted,
		watchdogAborted: result.stderr.includes(STREAM_IDLE_ABORT_MARKER),
		executionTimeout: result.stderr.includes(BASH_TIMEOUT_ABORT_MARKER),
		receiptPresent,
	});
	const recorded = readHandoffState(handoff.statePath);
	if (recorded.status === "done" || recorded.status === "blocked") {
		return {
			status: recorded.status === "blocked" ? "BLOCKED" : recorded.result ?? "PASS",
			// A child that regained control may have finished itself BLOCKED with
			// a more precise reason than can be reconstructed from its clean
			// process exit. Preserve the immutable state verdict in the pointer
			// returned to the planner instead of replacing it with a synthetic
			// DELEGATION_ARTIFACT_MISSING.
			reasons: recorded.status === "blocked" ? recorded.blockedReasons ?? reasons : [],
			receipt: receiptPresent ? handoff.receiptPath : null,
		};
	}
	if (reasons.length === 0) reasons.push("DELEGATION_ARTIFACT_MISSING");
	const fallbackSummary =
		eventLogExcerpt(result.errorMessage || result.stderr || result.content) ||
		MISSING_HANDOFF_FINISH_SUMMARY;
	finishBlocked(handoff.handoffId, reasons, fallbackSummary, cwd, fallbackSummary);
	return {
		status: "BLOCKED",
		reasons,
		receipt: receiptPresent ? handoff.receiptPath : null,
	};
}
