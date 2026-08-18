import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	deliverEvent,
	EVENT_KINDS,
	EVENT_REASONS,
	EVENT_STATUSES,
	eventSummary,
	eventLogExcerpt,
	MAX_EVENT_SUMMARY_CHARS,
	MAX_EVENT_LOG_SIDE_CHARS,
} from "../../runtime/lib/events";

let root: string | undefined;

afterEach(() => {
	if (root) fs.rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("event contract", () => {
	test("statuses and reasons are closed enums", () => {
		expect(EVENT_KINDS).toContain("run_resumed");
		expect(EVENT_STATUSES).toContain("BLOCKED");
		expect(EVENT_REASONS).toContain("PROVIDER_FAILURE");
	});

	test("event summaries are normalized to one bounded line", () => {
		expect(eventSummary("line one\nline two\t  end")).toBe("line one line two end");
		expect(Array.from(eventSummary("x".repeat(300))).length).toBe(MAX_EVENT_SUMMARY_CHARS);
	});

	test("missing-summary failures use a redacted head-and-tail log excerpt", () => {
		const head = "HEAD".repeat(30);
		const middle = "MIDDLE".repeat(50);
		const tail = "TAIL".repeat(25);
		const excerpt = eventLogExcerpt(
			`Authorization: Bearer abc123\n${head}${middle}${tail}`,
		);

		expect(excerpt).toContain("Authorization=[REDACTED]");
		expect(excerpt).toContain(" ... ");
		expect(excerpt).toContain(tail);
		expect(excerpt).not.toContain("abc123");
		expect(Array.from(excerpt).length).toBeLessThanOrEqual(MAX_EVENT_SUMMARY_CHARS);
		expect(MAX_EVENT_LOG_SIDE_CHARS).toBe(100);
	});

	test("delivery writes enum state plus a one-line summary", () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-events-"));
		const delivered = deliverEvent({
			stagingDir: path.join(root, "tmp"),
			targetDir: path.join(root, "events"),
			counterPath: path.join(root, ".events.seq"),
			subject: "run-test",
			kind: "handoff_finished",
			status: "BLOCKED",
			payload: {
				reasons: ["PROVIDER_FAILURE", "DELEGATION_ARTIFACT_MISSING"],
				summary: "provider failed\nquota exhausted",
			},
		});
		const body = JSON.parse(
			fs.readFileSync(path.join(root, "events", delivered.file), "utf8"),
		);
		expect(body.kind).toBe("handoff_finished");
		expect(body.status).toBe("BLOCKED");
		expect(body.seq).toBe(1);
		expect(body.reasons).toEqual(["PROVIDER_FAILURE", "DELEGATION_ARTIFACT_MISSING"]);
		expect(body.summary).toBe("provider failed quota exhausted");
	});

	test("unknown statuses and reasons are rejected", () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-events-"));
		const base = {
			stagingDir: path.join(root, "tmp"),
			targetDir: path.join(root, "events"),
			counterPath: path.join(root, ".events.seq"),
			subject: "run-test",
			payload: {},
		};
		expect(() =>
			deliverEvent({ ...base, kind: "run_finished", status: "WOKE_UP" }),
		).toThrow("unknown event status");
		expect(() =>
			deliverEvent({
				...base,
				kind: "run_finished",
				status: "BLOCKED",
				payload: { error: "monthly quota exhausted" },
			}),
		).toThrow("event payload field is not allowed");
		expect(() =>
			deliverEvent({
				...base,
				kind: "run_finished",
				status: "BLOCKED",
				payload: { reasons: ["QUOTA_EXCEEDED"] },
			}),
		).toThrow("unknown event reason");
	});
});
