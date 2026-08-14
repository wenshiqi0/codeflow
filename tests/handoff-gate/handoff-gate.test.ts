import { test, expect, describe } from "bun:test";
import {
	blockedReasons,
	delegationPointer,
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
