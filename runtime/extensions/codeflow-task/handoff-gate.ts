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
export const BLOCKED_OUTPUT_TRUNCATED = "OUTPUT_TRUNCATED";
export const BLOCKED_PROVIDER_FAILURE = "PROVIDER_FAILURE";
export const BLOCKED_USER_CANCELLED = "USER_CANCELLED";

export interface ChildOutcome {
	exitCode: number;
	stopReason?: string;
	aborted?: boolean;
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
 * both are recorded when both apply.
 */
export function blockedReasons(outcome: ChildOutcome): string[] {
	const reasons: string[] = [];
	if (outcome.aborted) {
		reasons.push(BLOCKED_USER_CANCELLED);
	} else {
		if (outcome.stopReason === "length") reasons.push(BLOCKED_OUTPUT_TRUNCATED);
		if (outcome.stopReason === "error" || outcome.exitCode !== 0) {
			reasons.push(BLOCKED_PROVIDER_FAILURE);
		}
	}
	if (!outcome.receiptPresent) reasons.push(BLOCKED_DELEGATION_ARTIFACT_MISSING);
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
