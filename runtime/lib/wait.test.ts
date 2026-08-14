/**
 * Contract tests for `codeflow wait`.
 *
 * The outer loop's correctness rests on three properties here: a reconnect
 * never replays, a timeout with no events is normal rather than a failure, and
 * only file names are ever read.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scan, wait, watchDir } from "./wait";

let dir: string;
let events: string;

function writeEvent(seq: number, subject: string, kind: string, status: string): void {
	fs.writeFileSync(
		path.join(events, `${String(seq).padStart(5, "0")}--${subject}--${kind}--${status}.json`),
		"{}\n",
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
		writeEvent(1, "h00001-planner", "handoff_opened", "OPEN");
		const [event] = scan(events, 0, []).events;
		expect(event).toEqual({
			seq: 1,
			subject: "h00001-planner",
			kind: "handoff_opened",
			status: "OPEN",
			file: "00001--h00001-planner--handoff_opened--OPEN.json",
		});
	});

	test("returns events in sequence order", () => {
		writeEvent(3, "a", "run_finished", "PASS");
		writeEvent(1, "b", "handoff_opened", "OPEN");
		expect(scan(events, 0, []).events.map((event) => event.seq)).toEqual([1, 3]);
	});

	test("since excludes what the caller already saw", () => {
		writeEvent(1, "a", "handoff_opened", "OPEN");
		writeEvent(2, "b", "handoff_finished", "PASS");
		expect(scan(events, 1, []).events.map((event) => event.seq)).toEqual([2]);
	});

	test("the watermark is the largest sequence seen", () => {
		writeEvent(1, "a", "handoff_opened", "OPEN");
		writeEvent(7, "b", "handoff_finished", "PASS");
		expect(scan(events, 0, []).waterMark).toBe(7);
	});

	test("a filtered kind still advances the watermark", () => {
		// Otherwise a later call would keep re-examining events it was told to
		// ignore.
		writeEvent(1, "a", "handoff_opened", "OPEN");
		writeEvent(2, "b", "artifact_written", "WRITTEN");
		const result = scan(events, 0, ["handoff_opened"]);
		expect(result.events).toHaveLength(1);
		expect(result.waterMark).toBe(2);
	});

	test("kind filtering selects only requested kinds", () => {
		writeEvent(1, "a", "handoff_opened", "OPEN");
		writeEvent(2, "b", "handoff_finished", "PASS");
		expect(scan(events, 0, ["handoff_finished"]).events.map((event) => event.kind)).toEqual([
			"handoff_finished",
		]);
	});

	test("several kinds may be requested", () => {
		writeEvent(1, "a", "handoff_opened", "OPEN");
		writeEvent(2, "b", "artifact_written", "WRITTEN");
		writeEvent(3, "c", "run_finished", "PASS");
		expect(scan(events, 0, ["handoff_opened", "run_finished"]).events).toHaveLength(2);
	});

	test("files that are not events are ignored", () => {
		fs.writeFileSync(path.join(events, "notes.txt"), "hello");
		fs.writeFileSync(path.join(events, "1--bad-name.json"), "{}");
		expect(scan(events, 0, []).events).toEqual([]);
	});

	test("a gap in the sequence is tolerated", () => {
		writeEvent(1, "a", "handoff_opened", "OPEN");
		writeEvent(5, "b", "handoff_finished", "PASS");
		expect(scan(events, 0, []).events.map((event) => event.seq)).toEqual([1, 5]);
	});
});

describe("waiting", () => {
	test("returns immediately when events already exist", async () => {
		writeEvent(1, "a", "handoff_opened", "OPEN");
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
		writeEvent(1, "a", "handoff_opened", "OPEN");
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
		writeEvent(1, "a", "handoff_finished", "PASS");
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
