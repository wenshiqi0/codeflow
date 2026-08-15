import { test, expect, describe } from "bun:test";
import * as handoffGate from "../../runtime/extensions/codeflow-task/handoff-gate";
import {
	blockedReasons,
	delegationPointer,
	immediateFailureReasons,
	isClean,
	type ChildOutcome,
} from "../../runtime/extensions/codeflow-task/handoff-gate";

function outcome(overrides: Partial<ChildOutcome> = {}): ChildOutcome {
	return { exitCode: 0, receiptPresent: true, ...overrides };
}

describe("blockedReasons", () => {
	test("a clean child with a receipt blocks on nothing", () => {
		expect(blockedReasons(outcome())).toEqual([]);
		expect(isClean(outcome())).toBe(true);
	});

	test("a missing receipt is a missing artifact, not a quiet success", () => {
		expect(blockedReasons(outcome({ receiptPresent: false }))).toEqual([
			"DELEGATION_ARTIFACT_MISSING",
		]);
		expect(isClean(outcome({ receiptPresent: false }))).toBe(false);
	});

	test("stopReason length is truncation", () => {
		expect(blockedReasons(outcome({ stopReason: "length" }))).toEqual([
			"OUTPUT_TRUNCATED",
		]);
	});

	test("truncation and a missing artifact are both recorded, cause first", () => {
		expect(
			blockedReasons(outcome({ stopReason: "length", receiptPresent: false })),
		).toEqual(["OUTPUT_TRUNCATED", "DELEGATION_ARTIFACT_MISSING"]);
	});

	test("a nonzero exit is a provider failure", () => {
		expect(blockedReasons(outcome({ exitCode: 1 }))).toEqual([
			"PROVIDER_FAILURE",
		]);
	});

	test("stopReason error is a provider failure even on exit 0", () => {
		expect(blockedReasons(outcome({ stopReason: "error" }))).toEqual([
			"PROVIDER_FAILURE",
		]);
	});

	test("cancellation is user cancellation, not a provider failure", () => {
		expect(
			blockedReasons(outcome({ aborted: true, exitCode: 143 })),
		).toEqual(["USER_CANCELLED"]);
	});

	test("a cancelled child with no receipt reports both facts", () => {
		expect(
			blockedReasons(outcome({ aborted: true, receiptPresent: false })),
		).toEqual(["USER_CANCELLED", "DELEGATION_ARTIFACT_MISSING"]);
	});

	test("a watchdog-aborted child is a provider failure, not a silent non-delivery", () => {
		// The stream-idle watchdog aborts the provider request from outside:
		// exit 0, stopReason "aborted", no receipt. Classifying that as only
		// DELEGATION_ARTIFACT_MISSING would blame the role for an external
		// abort, so the cause (PROVIDER_FAILURE) is recorded first.
		expect(
			blockedReasons(
				outcome({
					exitCode: 0,
					stopReason: "aborted",
					watchdogAborted: true,
					receiptPresent: false,
				}),
			),
		).toEqual(["PROVIDER_FAILURE", "DELEGATION_ARTIFACT_MISSING"]);
	});

	test("user cancellation still outranks the watchdog marker", () => {
		// outcome.aborted means a human cancelled; that fact leads even when
		// the watchdog also fired on the same child.
		expect(
			blockedReasons(
				outcome({ aborted: true, watchdogAborted: true, receiptPresent: false }),
			),
		).toEqual(["USER_CANCELLED", "DELEGATION_ARTIFACT_MISSING"]);
	});
});

describe("immediateFailureReasons", () => {
	test("provider stop errors are available before process close", () => {
		expect(
			immediateFailureReasons({ stopReason: "error", watchdogAborted: false, receiptPresent: false }),
		).toEqual(["PROVIDER_FAILURE", "DELEGATION_ARTIFACT_MISSING"]);
	});

	test("output truncation is available before process close", () => {
		expect(
			immediateFailureReasons({ stopReason: "length", watchdogAborted: false, receiptPresent: true }),
		).toEqual(["OUTPUT_TRUNCATED"]);
	});

	test("a stream-idle watchdog marker is an immediate provider failure", () => {
		expect(
			immediateFailureReasons({ stopReason: undefined, watchdogAborted: true, receiptPresent: false }),
		).toEqual(["PROVIDER_FAILURE", "DELEGATION_ARTIFACT_MISSING"]);
	});

	test("ordinary streaming messages do not create a failure event", () => {
		expect(
			immediateFailureReasons({ stopReason: undefined, watchdogAborted: false, receiptPresent: false }),
		).toEqual([]);
	});
});

describe("STREAM_IDLE_ABORT_MARKER", () => {
	test("is exported as the single producer/consumer contract", () => {
		// The watchdog writes this prefix on its abort line and the gate
		// matches on it; both sides import the one string so they cannot drift.
		// Namespace access keeps a missing export a test failure here rather
		// than a module-load error that hides the rest of this file.
		// biome-ignore lint/suspicious/noExplicitAny: the marker export is the contract under test
		const marker = (handoffGate as any).STREAM_IDLE_ABORT_MARKER;
		expect(typeof marker).toBe("string");
		expect(marker.length).toBeGreaterThan(0);
	});
});

describe("MISSING_HANDOFF_FINISH_SUMMARY", () => {
	test("is fixed so blocked prose cannot masquerade as success", () => {
		// Namespace access keeps a missing export a test failure here rather
		// than a module-load error that hides the rest of this file.
		const summary = (handoffGate as any).MISSING_HANDOFF_FINISH_SUMMARY;
		expect(summary).toBe("delegated role exited without calling handoff finish");
	});
});

describe("delegationPointer", () => {
	test("carries only pointers, in a fixed key order", () => {
		const pointer = delegationPointer(
			"h00002-test-runner",
			"FAIL",
			[],
			".codeflow/runs/code/r/handoffs/h00002-test-runner/receipt.json",
			".codeflow/runs/code/r/handoffs/h00002-test-runner/state.json",
		);
		expect(Object.keys(pointer)).toEqual([
			"handoff_id",
			"status",
			"reasons",
			"receipt",
			"state",
		]);
		expect(pointer.status).toBe("FAIL");
	});

	test("serializes without any receipt body", () => {
		const serialized = JSON.stringify(
			delegationPointer("h1-coder", "BLOCKED", ["OUTPUT_TRUNCATED"], null, "s.json"),
		);
		expect(serialized).toBe(
			'{"handoff_id":"h1-coder","status":"BLOCKED","reasons":["OUTPUT_TRUNCATED"],' +
				'"receipt":null,"state":"s.json"}',
		);
	});
});
