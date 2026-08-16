/**
 * Goal-aware handoff registration and reconciliation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
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
	type GoalLane,
	goalSessionId,
	loadGoal,
} from "../../lib/goals";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";
import type { RoleRunResult } from "./shared";

const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENTS_DIR = path.join(RUNTIME_DIR, "agents");
const WATCHDOG_EXTENSION = path.join(RUNTIME_DIR, "extensions", "agent-watchdog", "index.ts");
const CONTEXT_EXTENSION = path.join(RUNTIME_DIR, "extensions", "codeflow-context", "index.ts");
const BASH_COMPRESSOR_EXTENSION = path.join(RUNTIME_DIR, "extensions", "bash-compressor", "index.ts");
const USAGE_LEDGER_EXTENSION = path.join(RUNTIME_DIR, "extensions", "usage-ledger", "index.ts");
const ROLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_CONCURRENCY = 8;
const INTERNAL_ROLES = new Set(["zipper"]);

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
	lane: GoalLane;
	contract: GoalContract;
	sessionId: string;
}

export function resolveGoalTask(
	agent: string,
	goalId: string | undefined,
	lane: string | undefined,
): GoalTaskRef | null {
	if (!goalId && !lane) return null;
	if (!goalId || !lane) throw new TaskContractError("goal_id and lane must be provided together");
	if (!/^(?:test|code|verify)$/.test(lane)) throw new TaskContractError(`invalid goal lane: ${lane}`);
	const paths = currentRun();
	if (!paths) throw new Error("cannot use a goal task outside a Codeflow run");
	const contract = loadGoal(paths, goalId);
	const goalLane = lane as GoalLane;
	if (contract.lanes[goalLane].role !== agent) {
		throw new TaskContractError(
			`role ${agent} does not own goal ${contract.id} lane ${goalLane}; expected ${contract.lanes[goalLane].role}`,
		);
	}
	return {
		goalId: contract.id,
		lane: goalLane,
		contract,
		sessionId: goalSessionId(process.env.CODEFLOW_RUN_ID ?? "", contract.id, goalLane),
	};
}

export function assertGoalLaneAvailable(goal: GoalTaskRef): void {
	const paths = currentRun();
	if (!paths) return;
	const active = handoffHistory(paths).find(
		(state) =>
			state.goal_id === goal.goalId &&
			state.lane === goal.lane &&
			(state.status === "open" || state.status === "running"),
	);
	if (active) {
		throw new TaskContractError(
			`goal ${goal.goalId} lane ${goal.lane} already has active handoff ${active.handoff_id}`,
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
					goalId: goal.goalId,
					lane: goal.lane,
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

export function readHandoffState(statePath: string): { status?: string; result?: string } {
	try {
		const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
		return { status: state.status, result: state.result };
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
		receiptPresent,
	});
	const recorded = readHandoffState(handoff.statePath);
	if (recorded.status === "done" || recorded.status === "blocked") {
		return {
			status: recorded.status === "blocked" ? "BLOCKED" : recorded.result ?? "PASS",
			reasons: recorded.status === "blocked" ? reasons : [],
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
