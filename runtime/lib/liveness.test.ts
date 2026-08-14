/**
 * Contract tests for liveness probing.
 *
 * The property that matters is epistemic honesty: never report DEAD from one
 * signal, and keep "cannot tell" distinct from "gone". Killing a working run
 * costs far more than waiting for a slow one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	exitCodeFor,
	heartbeatAge,
	killProbe,
	passedSignals,
	probeAll,
	probeProcess,
	readLiveness,
	verdictFor,
	type Probe,
} from "./liveness";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-liveness-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function writeRecord(name: string, record: unknown): void {
	fs.writeFileSync(path.join(dir, name), JSON.stringify(record), "utf-8");
}

describe("signal probing", () => {
	test("our own process answers the signal probe", () => {
		expect(killProbe(process.pid)).toBe(true);
	});

	test("an unused pid answers false", () => {
		// 2^22 is above the default pid_max on Linux and macOS.
		expect(killProbe(4_194_303)).toBe(false);
	});

	test("probing our own process reports the kill signal passing", () => {
		expect(probeProcess(process.pid).killSucceeded).toBe(true);
	});
});

describe("verdicts", () => {
	test("all three signals agreeing means alive", () => {
		expect(
			verdictFor({ procPidExists: true, killSucceeded: true, cmdlineMatchesPi: true }),
		).toBe("ALIVE");
	});

	test("the two strongest signals failing means dead", () => {
		expect(
			verdictFor({ procPidExists: false, killSucceeded: false, cmdlineMatchesPi: null }),
		).toBe("DEAD");
	});

	test("a live process with an unmatched cmdline is not declared alive", () => {
		// PID reuse would otherwise let an unrelated process look like an agent.
		expect(
			verdictFor({ procPidExists: true, killSucceeded: true, cmdlineMatchesPi: false }),
		).toBe("UNKNOWN");
	});

	test("an absent /proc yields unknown rather than a guess", () => {
		// This is the normal case on macOS.
		expect(
			verdictFor({ procPidExists: null, killSucceeded: true, cmdlineMatchesPi: null }),
		).toBe("UNKNOWN");
	});

	test("partial disagreement is never reported as dead", () => {
		expect(
			verdictFor({ procPidExists: false, killSucceeded: true, cmdlineMatchesPi: null }),
		).toBe("UNKNOWN");
	});

	test("passed signals are named for the report", () => {
		expect(
			passedSignals({ procPidExists: true, killSucceeded: true, cmdlineMatchesPi: false }),
		).toEqual(["proc", "kill0"]);
	});
});

describe("heartbeat age", () => {
	test("a fresh heartbeat is near zero", () => {
		expect(heartbeatAge({ heartbeat_at: new Date().toISOString() })).toBeLessThanOrEqual(1);
	});

	test("prefers the heartbeat over the start time", () => {
		const now = Date.parse("2026-01-01T00:01:00.000Z");
		expect(
			heartbeatAge(
				{ started_at: "2026-01-01T00:00:00.000Z", heartbeat_at: "2026-01-01T00:00:30.000Z" },
				now,
			),
		).toBe(30);
	});

	test("falls back to the start time", () => {
		const now = Date.parse("2026-01-01T00:00:10.000Z");
		expect(heartbeatAge({ started_at: "2026-01-01T00:00:00.000Z" }, now)).toBe(10);
	});

	test("a missing timestamp yields null, not zero", () => {
		expect(heartbeatAge({})).toBeNull();
	});

	test("an unparseable timestamp yields null", () => {
		expect(heartbeatAge({ heartbeat_at: "not a date" })).toBeNull();
	});

	test("a future timestamp clamps to zero rather than going negative", () => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		expect(heartbeatAge({ heartbeat_at: "2026-01-01T00:01:00.000Z" }, now)).toBe(0);
	});
});

describe("reading liveness records", () => {
	test("a missing directory yields nothing", () => {
		expect(readLiveness(path.join(dir, "absent"))).toEqual([]);
	});

	test("reads records with a pid", () => {
		writeRecord("111--coder--1.json", { pid: 111, role: "coder", depth: 1 });
		expect(readLiveness(dir)).toHaveLength(1);
	});

	test("skips a damaged record instead of failing", () => {
		// One missing signal must not break the whole probe.
		writeRecord("111--coder--1.json", { pid: 111 });
		fs.writeFileSync(path.join(dir, "222--coder--1.json"), "{ not json", "utf-8");
		expect(readLiveness(dir)).toHaveLength(1);
	});

	test("ignores non-JSON files", () => {
		writeRecord("111--coder--1.json", { pid: 111 });
		fs.writeFileSync(path.join(dir, "notes.txt"), "hello");
		expect(readLiveness(dir)).toHaveLength(1);
	});

	test("skips a record without a pid", () => {
		writeRecord("bad.json", { role: "coder" });
		expect(readLiveness(dir)).toEqual([]);
	});
});

describe("probing all agents", () => {
	test("a recorded exit is authoritative without probing", () => {
		writeRecord("111--coder--1.json", { pid: 111, role: "coder", depth: 1, status: "exited" });
		const [probe] = probeAll(dir);
		expect(probe.verdict).toBe("DEAD");
	});

	test("our own pid is not reported dead", () => {
		writeRecord(`${process.pid}--planner--0.json`, {
			pid: process.pid,
			role: "planner",
			depth: 0,
			heartbeat_at: new Date().toISOString(),
		});
		expect(probeAll(dir)[0].verdict).not.toBe("DEAD");
	});

	test("role and depth travel with the probe", () => {
		writeRecord("111--coder--1.json", { pid: 111, role: "coder", depth: 1, status: "exited" });
		const [probe] = probeAll(dir);
		expect(probe.role).toBe("coder");
		expect(probe.depth).toBe(1);
	});
});

describe("exit codes", () => {
	function probe(verdict: Probe["verdict"]): Probe {
		return {
			pid: 1,
			verdict,
			procPidExists: null,
			killSucceeded: null,
			cmdlineMatchesPi: null,
			passedSignals: [],
			heartbeatAgeSeconds: null,
		};
	}

	test("all alive exits zero", () => {
		expect(exitCodeFor([probe("ALIVE"), probe("ALIVE")])).toBe(0);
	});

	test("any dead exits one", () => {
		expect(exitCodeFor([probe("ALIVE"), probe("DEAD")])).toBe(1);
	});

	test("uncertainty exits two, distinct from dead", () => {
		// Collapsing these is how a healthy run gets killed.
		expect(exitCodeFor([probe("ALIVE"), probe("UNKNOWN")])).toBe(2);
	});

	test("dead outranks unknown", () => {
		expect(exitCodeFor([probe("UNKNOWN"), probe("DEAD")])).toBe(1);
	});

	test("no agents exits zero", () => {
		expect(exitCodeFor([])).toBe(0);
	});
});
