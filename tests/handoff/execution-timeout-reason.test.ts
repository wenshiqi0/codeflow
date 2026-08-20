/**
 * Executable product contract: EXECUTION_TIMEOUT joins the closed blocked
 * enums — in the handoff state machine AND in the event plane (red-first).
 *
 * A blocked reason that exists in one enum but not the other cannot travel:
 * `handoff finish --blocked-reason EXECUTION_TIMEOUT` would pass state
 * validation and then blow up inside event delivery (or be silently
 * undeliverable), leaving the outer loop blind to the actual cause. This
 * contract pins:
 *
 * 1. BLOCKED_REASONS and EVENT_REASONS are exactly the previous five reasons
 *    plus EXECUTION_TIMEOUT — closed sets, extended deliberately, with no
 *    free-text escape.
 * 2. A handoff can finish BLOCKED with EXECUTION_TIMEOUT; the terminal
 *    state records it and the handoff_finished BLOCKED event body carries
 *    the reason.
 * 3. The reference docs remain the readable SSOT: references/handoff.md's
 *    blocked-reason table and the worker contract (runtime/AGENTS.md) list
 *    the new reason.
 *
 * Runner: bun test tests/handoff/execution-timeout-reason.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BLOCKED_REASONS, finishHandoff, openHandoff } from "../../runtime/lib/handoff";
import { EVENT_REASONS } from "../../runtime/lib/events";
import { RunPaths } from "../../runtime/lib/paths";

const RUN_ID = "run-timeout-reason-test";
const RUNS_DIR = ".codeflow/runs/code";
const REPO = path.resolve(import.meta.dir, "../..");

let dir: string;
let cwd: string;
let paths: RunPaths;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-timeout-reason-"));
	cwd = process.cwd();
	process.chdir(dir);
	paths = new RunPaths(RUNS_DIR, RUN_ID);
});

afterEach(() => {
	process.chdir(cwd);
	fs.rmSync(dir, { recursive: true, force: true });
});

function read(relativePath: string): string {
	return fs.readFileSync(path.join(REPO, relativePath), "utf8");
}

describe("EXECUTION_TIMEOUT blocked reason contract", () => {
	test("the handoff enum is closed: the previous five reasons plus EXECUTION_TIMEOUT", () => {
		// Exact-set assertion: adding any further reason is a deliberate
		// contract change that must update this pin, not a silent drift.
		expect(BLOCKED_REASONS).toEqual([
			"CONTEXT_BUDGET_EXCEEDED",
			"DELEGATION_ARTIFACT_MISSING",
			"EXECUTION_TIMEOUT",
			"OUTPUT_TRUNCATED",
			"PROVIDER_FAILURE",
			"USER_CANCELLED",
		]);
	});

	test("the event plane accepts the same reason", () => {
		expect(EVENT_REASONS).toEqual([
			"CONTEXT_BUDGET_EXCEEDED",
			"DELEGATION_ARTIFACT_MISSING",
			"EXECUTION_TIMEOUT",
			"OUTPUT_TRUNCATED",
			"PROVIDER_FAILURE",
			"USER_CANCELLED",
		]);
	});

	test("a handoff finishes BLOCKED with EXECUTION_TIMEOUT and the event carries the reason", () => {
		const opened = openHandoff(paths, {
			role: "verify",
			depth: 1,
			body: "Goal: run the named checks\n",
		});
		const result = finishHandoff(paths, {
			handoffId: opened.handoff_id,
			status: "BLOCKED",
			summary: "verification command exceeded the per-command timeout",
			blockedReasons: ["EXECUTION_TIMEOUT"],
			detail: "code-agent evidence run killed the process tree at the 12-minute default",
		});
		expect(result.status).toBe("BLOCKED");

		const state = JSON.parse(fs.readFileSync(paths.statePath(opened.handoff_id), "utf8")) as {
			status: string;
			blocked?: { reason?: string; reasons?: string[] };
		};
		expect(state.status).toBe("blocked");
		expect(state.blocked?.reason).toBe("EXECUTION_TIMEOUT");
		expect(state.blocked?.reasons).toEqual(["EXECUTION_TIMEOUT"]);

		// The event body is the outer loop's only listening surface: the
		// BLOCKED handoff_finished event must carry the closed reason.
		const finished = fs
			.readdirSync(paths.events)
			.map((name) => JSON.parse(fs.readFileSync(path.join(paths.events, name), "utf8")))
			.filter((body) => body.kind === "handoff_finished" && body.status === "BLOCKED");
		expect(finished).toHaveLength(1);
		expect(finished[0].reasons).toEqual(["EXECUTION_TIMEOUT"]);
	});

	test("the readable SSOT lists the reason: handoff reference and worker contract", () => {
		expect(read(path.join("references", "handoff.md"))).toContain("`EXECUTION_TIMEOUT`");
		expect(read(path.join("runtime", "AGENTS.md"))).toContain("EXECUTION_TIMEOUT");
	});
});
