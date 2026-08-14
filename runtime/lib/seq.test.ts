import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nextSeq } from "./seq";

let dir: string;
let counter: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-seq-"));
	counter = path.join(dir, ".events.seq");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("allocation", () => {
	test("starts at 1", () => {
		expect(nextSeq(counter)).toBe(1);
	});

	test("increases on each call", () => {
		expect([nextSeq(counter), nextSeq(counter), nextSeq(counter)]).toEqual([1, 2, 3]);
	});

	test("creates the counter directory on demand", () => {
		const nested = path.join(dir, "a", "b", ".events.seq");
		expect(nextSeq(nested)).toBe(1);
	});

	test("resumes above the recorded hint after a restart", () => {
		nextSeq(counter);
		nextSeq(counter);
		// A fresh process re-reads the hint rather than restarting at 1.
		expect(nextSeq(counter)).toBe(3);
	});

	test("independent counters do not interfere", () => {
		const other = path.join(dir, "other", ".events.seq");
		expect(nextSeq(counter)).toBe(1);
		expect(nextSeq(other)).toBe(1);
	});
});

describe("resilience", () => {
	test("a corrupt hint still yields an unused number", () => {
		nextSeq(counter);
		fs.writeFileSync(counter, "not a number", "utf-8");
		// Falls back to probing from 1; 1 is taken, so it advances.
		expect(nextSeq(counter)).toBe(2);
	});

	test("a hint that is too low never reissues a claimed number", () => {
		const claimed = [nextSeq(counter), nextSeq(counter), nextSeq(counter)];
		// Simulate a lost hint write: the markers remain the authority.
		fs.writeFileSync(counter, "1", "utf-8");
		expect(claimed).not.toContain(nextSeq(counter));
	});

	test("a missing hint recovers from the claim markers", () => {
		nextSeq(counter);
		nextSeq(counter);
		fs.rmSync(counter);
		expect(nextSeq(counter)).toBe(3);
	});

	test("a gap in the sequence is tolerated", () => {
		nextSeq(counter);
		// A number claimed by a process that then died leaves a hole. The
		// watermark is the largest seq seen, so holes cost nothing.
		fs.writeFileSync(path.join(dir, ".events.seq.d", "2"), "");
		expect(nextSeq(counter)).toBe(3);
	});
});

describe("cross-process concurrency", () => {
	/**
	 * Race real processes, not promises. Uniqueness has to hold across
	 * separate `pi` invocations, which an in-process test cannot prove.
	 */
	test("concurrent processes never receive the same number", async () => {
		const script = path.join(dir, "claim.ts");
		const seqModule = path.join(import.meta.dir, "seq.ts");
		const perProcess = 25;
		const processes = 8;
		fs.writeFileSync(
			script,
			`import { nextSeq } from ${JSON.stringify(seqModule)};\n` +
				`const out = [];\n` +
				`for (let i = 0; i < ${perProcess}; i++) out.push(nextSeq(${JSON.stringify(counter)}));\n` +
				`console.log(JSON.stringify(out));\n`,
			"utf-8",
		);

		const spawned = Array.from({ length: processes }, () =>
			Bun.spawn(["bun", "run", script], { stdout: "pipe", stderr: "pipe" }),
		);

		const collected: number[] = [];
		for (const proc of spawned) {
			const text = await new Response(proc.stdout).text();
			const code = await proc.exited;
			expect(code).toBe(0);
			collected.push(...(JSON.parse(text.trim()) as number[]));
		}

		expect(collected).toHaveLength(processes * perProcess);
		// The property that matters: no duplicates.
		expect(new Set(collected).size).toBe(collected.length);
	}, 30_000);

	test("every allocated number is positive", () => {
		const values = [nextSeq(counter), nextSeq(counter)];
		for (const value of values) expect(value).toBeGreaterThan(0);
	});
});
