/**
 * Pure decision logic for reconciling a finished delegation.
 *
 * A child that stopped without recording a terminal handoff has not
 * succeeded quietly — something ended it. This module turns the observable
 * facts (exit code, stop reason, cancellation, whether a receipt landed)
 * into the blocked reasons the mechanical layer records. It never retries:
 * a later attempt is an explicit new handoff, not a hidden loop.
 */

export const BLOCKED_DELEGATION_ARTIFACT_MISSING = "DELEGATION_ARTIFACT_MISSING";
export const BLOCKED_EXECUTION_TIMEOUT = "EXECUTION_TIMEOUT";
export const BLOCKED_OUTPUT_TRUNCATED = "OUTPUT_TRUNCATED";
export const BLOCKED_PROVIDER_FAILURE = "PROVIDER_FAILURE";
export const BLOCKED_USER_CANCELLED = "USER_CANCELLED";

/**
 * A fixed summary prevents a delegator from treating a child's unvalidated
 * final prose as success evidence. Prose may appear only in blocked.detail.
 */
export const MISSING_HANDOFF_FINISH_SUMMARY = "delegated role exited without calling handoff finish";

/**
 * Single producer/consumer contract: the agent-watchdog's stderr abort line
 * begins with this prefix, and reconcileHandoff matches on it to recognise
 * a stream-idle abort. Both sides import this one string so they cannot
 * drift apart.
 */
export const STREAM_IDLE_ABORT_MARKER = "[agent-watchdog] stream idle";

/**
 * Same contract for the bash wall-time guard: the agent-watchdog writes this
 * prefix when a bash tool exceeds its hard limit, and the gate classifies the
 * child as an execution timeout — a distinct cause from both a provider
 * failure and a user cancellation.
 */
export const BASH_TIMEOUT_ABORT_MARKER = "[agent-watchdog] bash timeout";

export interface ChildOutcome {
	exitCode: number;
	stopReason?: string;
	aborted?: boolean;
	/** The stream-idle watchdog aborted this child's provider request (external abort, not user cancellation). */
	watchdogAborted?: boolean;
	/** A bash tool in this child exceeded its wall-time limit (the watchdog's bash guard aborted the turn). */
	executionTimeout?: boolean;
	receiptPresent: boolean;
}

export interface DelegationPointer {
	handoff_id: string;
	status: string;
	reasons: string[];
	receipt: string | null;
	state: string;
}

/**
 * Reasons in cause-first order: what ended the child, then what is missing
 * as a result. Truncation and a missing artifact are two separate facts and
 * both are recorded when both apply. An execution timeout explains the
 * child's nonzero exit and aborted stop reason, so it replaces — not joins —
 * the provider-failure classification, while an explicit user cancellation
 * still outranks it: a human stopping the run is the cause, the timeout only
 * a consequence.
 */
export function blockedReasons(outcome: ChildOutcome): string[] {
	const reasons: string[] = [];
	if (outcome.aborted) {
		reasons.push(BLOCKED_USER_CANCELLED);
	} else {
		if (outcome.executionTimeout) reasons.push(BLOCKED_EXECUTION_TIMEOUT);
		if (
			!outcome.executionTimeout &&
			(outcome.stopReason === "error" || outcome.exitCode !== 0 || outcome.watchdogAborted)
		) {
			reasons.push(BLOCKED_PROVIDER_FAILURE);
		}
	}
	if (outcome.stopReason === "length") reasons.push(BLOCKED_OUTPUT_TRUNCATED);
	if (!outcome.receiptPresent) reasons.push(BLOCKED_DELEGATION_ARTIFACT_MISSING);
	return reasons;
}

/**
 * Reasons that can be identified from a terminal provider stream signal before
 * the child process has fully closed. They are delivered immediately so the
 * outer loop observes state, never provider prose.
 */
export function immediateFailureReasons(
	outcome: Pick<
		ChildOutcome,
		"stopReason" | "watchdogAborted" | "executionTimeout" | "receiptPresent"
	>,
): string[] {
	const reasons: string[] = [];
	if (outcome.executionTimeout) reasons.push(BLOCKED_EXECUTION_TIMEOUT);
	if (!outcome.executionTimeout && (outcome.stopReason === "error" || outcome.watchdogAborted)) {
		reasons.push(BLOCKED_PROVIDER_FAILURE);
	}
	if (outcome.stopReason === "length") reasons.push(BLOCKED_OUTPUT_TRUNCATED);
	if (reasons.length > 0 && !outcome.receiptPresent) {
		reasons.push(BLOCKED_DELEGATION_ARTIFACT_MISSING);
	}
	return reasons;
}

/**
 * True when the child left nothing for the mechanical layer to correct.
 */
export function isClean(outcome: ChildOutcome): boolean {
	return blockedReasons(outcome).length === 0;
}

/**
 * The delegator's whole return value: a pointer, never the receipt body.
 * Fixed key order keeps the caller's context byte-stable across turns.
 */
export function delegationPointer(
	handoffId: string,
	status: string,
	reasons: string[],
	receipt: string | null,
	state: string,
): DelegationPointer {
	return { handoff_id: handoffId, status, reasons, receipt, state };
}
