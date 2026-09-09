/**
 * Contract tests for the event-stream wait, which `codeflow sub` exposes.
 *
 * The outer loop's correctness rests on three properties here: a reconnect
 * never replays, a timeout with no events is normal rather than a failure, and
 * only filename metadata and the whitelisted event enum/summary are read.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scan, wait, watchDir } from "../../runtime/lib/wait";

let dir: string;
let events: string;

function writeEvent(
	seq: number,
	subject: string,
	kind: string,
	status: string,
	body: Record<string, unknown> = {},
): void {
	fs.writeFileSync(
		path.join(events, `${String(seq).padStart(5, "0")}--${subject}--${kind}--${status}.json`),
		JSON.stringify(body) + "\n",
	);
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-wait-"));
	events = path.join(dir, "run-1", "events");
	fs.mkdirSync(events, { recursive: true });
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("watch directory", () => {
	test("a named run watches its own event stream", () => {
		expect(watchDir("/runs", "run-1")).toBe(path.join("/runs", "run-1", "events"));
	});

	test("discovery watches the shared spool", () => {
		expect(watchDir("/runs")).toBe(path.join("/runs", "_spool"));
	});
});

describe("scanning", () => {
	test("an empty directory yields nothing", () => {
		expect(scan(events, 0, [])).toEqual({ events: [], waterMark: 0 });
	});

	test("a missing directory is not an error", () => {
		// The observer never creates directories; it waits for the run to.
		expect(scan(path.join(dir, "absent"), 0, [])).toEqual({ events: [], waterMark: 0 });
	});

	test("parses every field from the file name alone", () => {
		writeEvent(1, "c00001-planner", "commitment_claimed", "RUNNING");
		const [event] = scan(events, 0, []).events;
		expect(event).toEqual({
			seq: 1,
			subject: "c00001-planner",
			kind: "commitment_claimed",
			status: "RUNNING",
			file: "00001--c00001-planner--commitment_claimed--RUNNING.json",
			summary: "commitment_claimed RUNNING",
		});
	});

	test("reads only whitelisted reasons and one-line summary from a terminal body", () => {
		writeEvent(2, "c00002-tester", "execution_interrupted", "BLOCKED", {
			reasons: ["PROVIDER_FAILURE", "COMMITMENT_CLAIM_MISSING"],
			summary: "provider request ended with error",
			ref: "commitments/c00002/receipts/r_test.json",
			error: "monthly quota exhausted",
			prose: "long diagnostic narrative",
		});
		const [event] = scan(events, 0, []).events;
		expect(event.reasons).toEqual(["PROVIDER_FAILURE", "COMMITMENT_CLAIM_MISSING"]);
		expect(event.summary).toBe("provider request ended with error");
		expect(Object.keys(event)).not.toContain("ref");
		expect(Object.keys(event)).not.toContain("error");
		expect(Object.keys(event)).not.toContain("prose");
	});

	test("returns events in sequence order", () => {
		writeEvent(3, "a", "run_finished", "PASS");
		writeEvent(1, "b", "commitment_claimed", "RUNNING");
		expect(scan(events, 0, []).events.map((event) => event.seq)).toEqual([1, 3]);
	});
	test("passes only bounded identifiers alongside the public event projection", () => {
		writeEvent(4, "c-one", "receipt_submitted", "PROGRESS", {
			task_id: "task-one", goal_id: "goal-one", agent_id: "agent-one", execution_id: "exec-one",
			commitment_id: "c_one", receipt_id: "r_one", prompt: "PRIVATE", session_path: "/private/session.jsonl",
		});
		const result = scan(events, 0, []).events[0];
		expect(result).toMatchObject({ task_id: "task-one", agent_id: "agent-one", execution_id: "exec-one", receipt_id: "r_one" });
		expect(result).not.toHaveProperty("prompt"); expect(result).not.toHaveProperty("session_path");
		writeEvent(5, "a", "agent_assigned", "STARTING", { execution_id: "../../escape", agent_id: "a".repeat(129) });
		const invalid = scan(events, 4, []).events[0];
		expect(invalid).not.toHaveProperty("execution_id"); expect(invalid).not.toHaveProperty("agent_id");
	});

	test("since excludes what the caller already saw", () => {
		writeEvent(1, "a", "commitment_claimed", "RUNNING");
		writeEvent(2, "b", "execution_interrupted", "PASS");
		expect(scan(events, 1, []).events.map((event) => event.seq)).toEqual([2]);
	});

	test("the watermark is the largest sequence seen", () => {
		writeEvent(1, "a", "commitment_claimed", "RUNNING");
		writeEvent(7, "b", "execution_interrupted", "PASS");
		expect(scan(events, 0, []).waterMark).toBe(7);
	});

	test("a filtered kind still advances the watermark", () => {
		// Otherwise a later call would keep re-examining events it was told to
		// ignore.
		writeEvent(1, "a", "commitment_claimed", "RUNNING");
		writeEvent(2, "b", "artifact_written", "WRITTEN");
		const result = scan(events, 0, ["commitment_claimed"]);
		expect(result.events).toHaveLength(1);
		expect(result.waterMark).toBe(2);
	});

	test("kind filtering selects only requested kinds", () => {
		writeEvent(1, "a", "commitment_claimed", "RUNNING");
		writeEvent(2, "b", "execution_interrupted", "PASS");
		expect(scan(events, 0, ["execution_interrupted"]).events.map((event) => event.kind)).toEqual([
			"execution_interrupted",
		]);
	});

	test("several kinds may be requested", () => {
		writeEvent(1, "a", "commitment_claimed", "RUNNING");
		writeEvent(2, "b", "artifact_written", "WRITTEN");
		writeEvent(3, "c", "run_finished", "PASS");
		expect(scan(events, 0, ["commitment_claimed", "run_finished"]).events).toHaveLength(2);
	});

	test("files that are not events are ignored", () => {
		fs.writeFileSync(path.join(events, "notes.txt"), "hello");
		fs.writeFileSync(path.join(events, "1--bad-name.json"), "{}");
		expect(scan(events, 0, []).events).toEqual([]);
	});

	test("a gap in the sequence is tolerated", () => {
		writeEvent(1, "a", "commitment_claimed", "RUNNING");
		writeEvent(5, "b", "execution_interrupted", "PASS");
		expect(scan(events, 0, []).events.map((event) => event.seq)).toEqual([1, 5]);
	});
});

describe("waiting", () => {
	test("returns immediately when events already exist", async () => {
		writeEvent(1, "a", "commitment_claimed", "RUNNING");
		const started = Date.now();
		const result = await wait({
			runsDir: dir,
			runId: "run-1",
			since: 0,
			kinds: [],
			timeoutSeconds: 5,
		});
		// Scanning before waiting is what keeps an observer from stalling
		// behind events already on disk.
		expect(result.events).toHaveLength(1);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	test("a timeout with no events is normal, not a failure", async () => {
		const result = await wait({
			runsDir: dir,
			runId: "run-1",
			since: 0,
			kinds: [],
			timeoutSeconds: 1,
		});
		expect(result.events).toEqual([]);
		expect(result.seq).toBe(0);
	});

	test("reconnecting at the watermark never replays", async () => {
		writeEvent(1, "a", "commitment_claimed", "RUNNING");
		const first = await wait({
			runsDir: dir,
			runId: "run-1",
			since: 0,
			kinds: [],
			timeoutSeconds: 2,
		});
		const second = await wait({
			runsDir: dir,
			runId: "run-1",
			since: first.seq,
			kinds: [],
			timeoutSeconds: 1,
		});
		expect(second.events).toEqual([]);
		expect(second.seq).toBe(first.seq);
	});

	test("wakes when an event arrives during the wait", async () => {
		const pending = wait({
			runsDir: dir,
			runId: "run-1",
			since: 0,
			kinds: [],
			timeoutSeconds: 10,
		});
		await Bun.sleep(150);
		writeEvent(1, "a", "execution_interrupted", "PASS");
		const result = await pending;
		expect(result.events.map((event) => event.seq)).toEqual([1]);
	}, 15_000);

	test("waits for a directory that does not exist yet", async () => {
		// The run may not have started when the observer attaches.
		const pending = wait({
			runsDir: dir,
			runId: "run-later",
			since: 0,
			kinds: [],
			timeoutSeconds: 10,
		});
		await Bun.sleep(150);
		const later = path.join(dir, "run-later", "events");
		fs.mkdirSync(later, { recursive: true });
		fs.writeFileSync(path.join(later, "00001--a--run_started--STARTED.json"), "{}");
		expect((await pending).events).toHaveLength(1);
	}, 15_000);

	test("discovery mode reports run-level events from the spool", async () => {
		const spool = path.join(dir, "_spool");
		fs.mkdirSync(spool, { recursive: true });
		fs.writeFileSync(path.join(spool, "00001--run-1--run_started--STARTED.json"), "{}");
		const result = await wait({ runsDir: dir, since: 0, kinds: [], timeoutSeconds: 2 });
		expect(result.run_id).toBeNull();
		expect(result.events).toHaveLength(1);
	});
});

describe("context pressure projection", () => {
	const measurement = {
		basis: "pi_estimate",
		utilization: 0.72,
		threshold: 0.7,
		tokens: 144_000,
		context_window: 200_000,
	};

	test("other event kinds and statuses cannot expose pressure measurements", () => {
		writeEvent(1, "agent-pressure", "goal_updated", "UPDATED", { context_pressure: measurement });
		writeEvent(2, "agent-pressure", "context_pressure", "BLOCKED", { context_pressure: measurement });
		const results = scan(events, 0, []).events;
		expect(results).toHaveLength(2);
		expect(results.every(event => event.context_pressure === undefined)).toBe(true);
	});

	test("attaches only the parsed whitelist, never the raw measurement payload", () => {
		writeEvent(2, "agent-pressure", "context_pressure", "UPDATED", {
			task_id: "task-one",
			goal_id: "task-one",
			agent_id: "agent-one",
			execution_id: "exec-one",
			commitment_id: "c_one",
			context_pressure: {
				...measurement,
				model_prose: "the model feels squeezed",
				session_path: "/private/session.jsonl",
			},
			prompt: "PRIVATE",
		});
		const [event] = scan(events, 0, []).events;
		expect(event).toMatchObject({ kind: "context_pressure", status: "UPDATED" });
		expect(event.context_pressure).toEqual(measurement);
		expect(event.commitment_id).toBe("c_one");
		expect(JSON.stringify(event)).not.toContain("model_prose");
		expect(JSON.stringify(event)).not.toContain("/private/session.jsonl");
		expect(JSON.stringify(event)).not.toContain("PRIVATE");
	});

	test("a malformed measurement degrades to an event without the projection", () => {
		const malformed = [
			{ ...measurement, basis: "vibes" },
			{ ...measurement, threshold: 0.6 },
			{ ...measurement, utilization: "high" },
			{ ...measurement, tokens: -1 },
			{ ...measurement, context_window: 0 },
			// utilization below the crossed threshold is not a pressure event
			{ ...measurement, utilization: 0.6, threshold: 0.7, tokens: 120_000 },
			// tokens/context_window must equal utilization exactly
			{ ...measurement, utilization: 0.75, tokens: 145_000 },
		];
		for (const [index, bad] of malformed.entries()) {
			writeEvent(3 + index, "agent-pressure", "context_pressure", "UPDATED", { context_pressure: bad });
		}
		writeEvent(10, "agent-pressure", "context_pressure", "UPDATED", { context_pressure: "high" });
		const results = scan(events, 0, []).events;
		expect(results).toHaveLength(8);
		expect(results.every((event) => event.kind === "context_pressure" && !("context_pressure" in event))).toBe(
			true,
		);
	});

	test("delivers a pressure signal in real time with its projection", async () => {
		const pending = wait({
			runsDir: dir,
			runId: "run-1",
			since: 0,
			kinds: ["context_pressure"],
			timeoutSeconds: 10,
		});
		await Bun.sleep(150);
		writeEvent(1, "agent-pressure", "context_pressure", "UPDATED", {
			execution_id: "exec-one",
			agent_id: "agent-one",
			context_pressure: measurement,
		});
		const result = await pending;
		expect(result.events).toHaveLength(1);
		expect(result.events[0].context_pressure).toEqual(measurement);
	}, 15_000);

	test("reconnecting at the watermark never replays the same pressure signal", async () => {
		writeEvent(1, "agent-pressure", "context_pressure", "UPDATED", { context_pressure: measurement });
		const first = await wait({
			runsDir: dir,
			runId: "run-1",
			since: 0,
			kinds: ["context_pressure"],
			timeoutSeconds: 2,
		});
		expect(first.events).toHaveLength(1);
		const second = await wait({
			runsDir: dir,
			runId: "run-1",
			since: first.seq,
			kinds: ["context_pressure"],
			timeoutSeconds: 1,
		});
		expect(second.events).toEqual([]);
		expect(second.seq).toBe(first.seq);
	});
});
