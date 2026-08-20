/**
 * Executable product contract: EXECUTION_TIMEOUT as a delegation cause.
 *
 * SSOT for classifying a child delegation whose verification command
 * exceeded an execution timeout. The agent-watchdog's bash guard aborts a
 * child turn by writing a marker line ("[agent-watchdog] bash timeout ...")
 * to stderr and calling ctx.abort(). Today reconcileHandoff only knows the
 * stream-idle marker, so a bash-timeout child reconciles to generic
 * PROVIDER_FAILURE (via its nonzero exit) — or worse, looks like an
 * unexplained missing artifact. This contract pins the intended
 * classification BEFORE implementation (red-first):
 *
 * 1. The bash-timeout marker is a distinct cause: EXECUTION_TIMEOUT, not
 *    PROVIDER_FAILURE, and never a bare DELEGATION_ARTIFACT_MISSING.
 * 2. Cause-first order: the cause leads; a missing receipt trails it.
 * 3. Explicit user cancellation still outranks the marker (a human stopped
 *    the run; the timeout is a consequence, not the cause).
 * 4. The other closed classifications do not regress: stream-idle abort
 *    stays PROVIDER_FAILURE; output truncation stays OUTPUT_TRUNCATED; a
 *    genuinely unexplained missing artifact stays
 *    DELEGATION_ARTIFACT_MISSING — distinct from EXECUTION_TIMEOUT.
 * 5. The marker string is a single producer/consumer contract shared with
 *    the watchdog, like STREAM_IDLE_ABORT_MARKER, so the two sides cannot
 *    drift apart.
 * 6. The classification is available immediately (before process close), so
 *    the blocked event reflects the actual cause as soon as it is observed.
 *
 * Runner: bun test tests/handoff-gate/execution-timeout.test.ts
 */

import { describe, expect, test } from "bun:test";
import * as handoffGate from "../../runtime/extensions/codeflow-task/handoff-gate";
import {
	blockedReasons,
	immediateFailureReasons,
	type ChildOutcome,
} from "../../runtime/extensions/codeflow-task/handoff-gate";
// Cache-busting query: this module reads CODEFLOW_* env at import time, and
// tests/agent-watchdog relies on being the first plain-path import. Any other
// test file must take a query-string instance (the established convention).
import * as agentWatchdog from "../../runtime/extensions/agent-watchdog/index.ts?gate-marker";

function outcome(overrides: Partial<ChildOutcome> = {}): ChildOutcome {
	return { exitCode: 0, receiptPresent: true, ...overrides };
}

describe("EXECUTION_TIMEOUT classification contract", () => {
	test("a bash-watchdog timeout is EXECUTION_TIMEOUT, not a provider failure", () => {
		// exitCode is whatever the aborted turn happened to leave; the marker
		// is the actual cause and must own the classification.
		expect(blockedReasons(outcome({ executionTimeout: true }))).toEqual(["EXECUTION_TIMEOUT"]);
		expect(blockedReasons(outcome({ executionTimeout: true, exitCode: 1 }))).toEqual([
			"EXECUTION_TIMEOUT",
		]);
	});

	test("the cause leads and a missing receipt trails it", () => {
		expect(
			blockedReasons(outcome({ executionTimeout: true, receiptPresent: false })),
		).toEqual(["EXECUTION_TIMEOUT", "DELEGATION_ARTIFACT_MISSING"]);
	});

	test("explicit user cancellation still outranks the timeout marker", () => {
		// A human cancelled while the bash guard also fired: USER_CANCELLED
		// is the cause; the timeout is only a consequence of stopping.
		expect(
			blockedReasons(outcome({ aborted: true, executionTimeout: true, receiptPresent: false })),
		).toEqual(["USER_CANCELLED", "DELEGATION_ARTIFACT_MISSING"]);
		expect(blockedReasons(outcome({ aborted: true, executionTimeout: true }))).toEqual([
			"USER_CANCELLED",
		]);
	});

	test("a stream-idle abort stays PROVIDER_FAILURE — distinct from a bash timeout", () => {
		// Regression pin: the provider-side watchdog classification must not
		// move when the execution-timeout class is added.
		expect(
			blockedReasons(
				outcome({ exitCode: 0, stopReason: "aborted", watchdogAborted: true, receiptPresent: false }),
			),
		).toEqual(["PROVIDER_FAILURE", "DELEGATION_ARTIFACT_MISSING"]);
	});

	test("an execution timeout does not erase an output truncation fact", () => {
		// Both facts are recorded, cause-first; the blocked record is the
		// audit trail, so neither cause may silently win over the other.
		const reasons = blockedReasons(
			outcome({ executionTimeout: true, stopReason: "length", receiptPresent: false }),
		);
		expect(reasons).toContain("EXECUTION_TIMEOUT");
		expect(reasons).toContain("OUTPUT_TRUNCATED");
		expect(reasons[reasons.length - 1]).toBe("DELEGATION_ARTIFACT_MISSING");
	});

	test("a genuinely unexplained missing artifact stays its own class", () => {
		// exit 0, no markers, no receipt: nothing explains the child. That
		// must remain DELEGATION_ARTIFACT_MISSING alone — merging it into
		// EXECUTION_TIMEOUT would hide unknown failures behind a known one.
		expect(blockedReasons(outcome({ receiptPresent: false }))).toEqual([
			"DELEGATION_ARTIFACT_MISSING",
		]);
	});

	test("the classification is immediate: available before the child closes", () => {
		expect(
			immediateFailureReasons({ executionTimeout: true, receiptPresent: false }),
		).toEqual(["EXECUTION_TIMEOUT", "DELEGATION_ARTIFACT_MISSING"]);
		expect(immediateFailureReasons({ executionTimeout: true, receiptPresent: true })).toEqual([
			"EXECUTION_TIMEOUT",
		]);
		// Ordinary streaming still creates nothing.
		expect(
			immediateFailureReasons({ stopReason: undefined, executionTimeout: false, receiptPresent: false }),
		).toEqual([]);
	});

	test("the immediate timeout cause suppresses derivative provider signals", () => {
		expect(
			immediateFailureReasons({
				stopReason: "error",
				watchdogAborted: true,
				executionTimeout: true,
				receiptPresent: false,
			}),
		).toEqual(["EXECUTION_TIMEOUT", "DELEGATION_ARTIFACT_MISSING"]);
	});

	test("the bash-timeout marker is a single shared producer/consumer contract", () => {
		// handoff-gate matches what agent-watchdog writes. Namespace access
		// keeps a missing export a failure here instead of a module-load
		// error that hides the rest of this file.
		const gateMarker = (handoffGate as { BASH_TIMEOUT_ABORT_MARKER?: string })
			.BASH_TIMEOUT_ABORT_MARKER;
		const watchdogMarker = (agentWatchdog as { BASH_TIMEOUT_ABORT_MARKER?: string })
			.BASH_TIMEOUT_ABORT_MARKER;
		expect(typeof gateMarker).toBe("string");
		expect(gateMarker!.length).toBeGreaterThan(0);
		expect(gateMarker).toBe(watchdogMarker);
		expect(gateMarker).toBe("[agent-watchdog] bash timeout");
	});
});
