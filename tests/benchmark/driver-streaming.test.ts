/**
 * Developer tests for the PRODUCTION default driver script
 * (runtime/scripts/benchmark/codeflow-driver.ts) — the innermost live
 * boundary: the `codeflow exec` process it spawns per attempt.
 *
 * The acceptance suite (realmode-*.test.ts) pins the runner<->driver seam
 * with a fake driver that streams by construction; it cannot see whether the
 * PRODUCTION default itself streams. These tests substitute only the INNER
 * `codeflow` binary (CODEFLOW_BENCHMARK_CODEFLOW_BIN -> fakes/inner-codeflow.sh,
 * spawned exactly like the real one: `bash <bin> exec "<prompt>"`) and pin
 * design §4/§5 + contract §1.7.1 against the real script:
 *
 * - ledger rows stream as DriverEvents WHILE the spawned Codeflow process is
 *   still alive (the runner can therefore supervise budgets of a live run);
 * - usage rows become rounds WITHOUT attached tool_calls; terminated tool
 *   calls become standalone `tool_calls` events; a request that never
 *   terminates is emitted `incomplete` once the process has ended;
 * - SIGTERM to the driver is forwarded to the live Codeflow process (budget
 *   stops terminate the whole run, not just the tailer);
 * - the driver exits with the Codeflow process's exit code.
 *
 * Liveness is observable process-to-process: the fake records its pid before
 * anything else, and the assertions check `pidAlive` at the moment each
 * streamed event is received. A tailer that buffered stdout until exit fails
 * every "while alive" assertion.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseEnv, cleanupTmpDirs, makeTmpDir, readJson, readJsonl, REPO, runCodeflow, writeInstancesFile } from "./helpers";
import { buildRealmodeWorld, INSTANCE_RESOLVED, pidAlive, type RealmodeWorld } from "./realmode-world";

const DRIVER_SCRIPT = path.join(REPO, "runtime", "scripts", "benchmark", "codeflow-driver.ts");
const FAKE_INNER = path.join(REPO, "tests", "benchmark", "fakes", "inner-codeflow.sh");

const PROJECTION = {
	instance_id: "demo/demo-1",
	repo: "demo/repo",
	base_commit: "a".repeat(40),
	problem_statement: "PROD-STREAM problem statement marker",
};

interface DriverHandle {
	/** Streamed DriverEvents, in stdout order. */
	events: Array<Record<string, any>>;
	/** pidAlive(innerPid) sampled as each event was received. */
	aliveAtEvent: boolean[];
	/** The fake inner process's capture dir (markers live here). */
	capture: string;
	/** Resolves with the driver's exit code once the process has exited. */
	finished: Promise<number | null>;
	/** SIGTERM/SIGKILL the driver process — what a budget stop does. */
	kill: (signal?: "SIGTERM" | "SIGKILL") => void;
}

let world: RealmodeWorld;

beforeAll(() => {
	world = buildRealmodeWorld();
}, 60_000);

afterAll(cleanupTmpDirs);

function pidAlive(pid: number | undefined): boolean {
	if (pid === undefined || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function* streamLines(stream: unknown): AsyncGenerator<string> {
	if (!stream || typeof (stream as ReadableStream).getReader !== "function") return;
	const reader = (stream as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				yield buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			/* stream closed with the process */
		}
	}
}

function captureJson(capture: string, name: string): any | null {
	const file = path.join(capture, name);
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const started = Date.now();
	return new Promise<void>((resolve, reject) => {
		const tick = (): void => {
			if (predicate()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${what}`));
			setTimeout(tick, 25);
		};
		tick();
	});
}

/**
 * Spawn the PRODUCTION driver script with the fake inner `codeflow` binary
 * and consume its stdout lazily, recording the inner process's liveness at
 * every event. `stopAfterRounds` stops consuming once enough rounds streamed
 * (the kill-test path; the driver is then signalled by the caller).
 */
async function runDriver(options: {
	mode: string;
	intervalMs?: number;
	stopAfterRounds?: number;
}): Promise<DriverHandle> {
	const root = makeTmpDir("codeflow-bench-drvstream-");
	const capture = path.join(root, "capture");
	const workspace = path.join(root, "cases", "demo__demo-1", "attempts", "1", "workspace");
	fs.mkdirSync(workspace, { recursive: true });

	const env: Record<string, string> = {
		...baseEnv(),
		CODEFLOW_BENCHMARK_CODEFLOW_BIN: FAKE_INNER,
		FAKE_INNER_CAPTURE_DIR: capture,
		FAKE_INNER_MODE: options.mode,
	};
	if (options.intervalMs !== undefined) env.FAKE_INNER_INTERVAL_MS = String(options.intervalMs);

	const child = Bun.spawn(
		[process.execPath, DRIVER_SCRIPT, "--workspace", workspace, "--attempt", "1", "--model-config", "default"],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe", env },
	);
	child.stdin!.write(`${JSON.stringify(PROJECTION)}\n`);
	child.stdin!.end();

	const events: Array<Record<string, any>> = [];
	const aliveAtEvent: boolean[] = [];
	let innerPid: number | undefined;
	const readInnerPid = (): void => {
		if (innerPid === undefined) {
			const file = path.join(capture, "inner-pid");
			if (fs.existsSync(file)) innerPid = Number(fs.readFileSync(file, "utf8"));
		}
	};

	const finished = (async () => {
		try {
			for await (const line of streamLines(child.stdout)) {
				if (line.trim() === "") continue;
				readInnerPid();
				events.push(JSON.parse(line));
				aliveAtEvent.push(pidAlive(innerPid));
				if (options.stopAfterRounds !== undefined) {
					const rounds = events.filter((event) => event.type === "round").length;
					if (rounds >= options.stopAfterRounds) break;
				}
			}
		} catch {
			/* the driver's stdout ends with the process; the exit code decides */
		}
		return await child.exited;
	})();

	return {
		get events() {
			return events;
		},
		get aliveAtEvent() {
			return aliveAtEvent;
		},
		capture,
		finished,
		kill: (signal: "SIGTERM" | "SIGKILL" = "SIGTERM") => {
			child.kill(signal);
		},
	};
}

describe("production codeflow-driver.ts streams from the live Codeflow process", () => {
	test("round/tool events arrive while the spawned process is still alive", async () => {
		const run = await runDriver({ mode: "scripted" });
		await run.finished;

		expect(run.events.map((event) => event.type)).toEqual([
			"round",
			"tool_calls",
			"round",
			"tool_calls",
		]);

		// Production protocol (contract §1.7): rounds carry usage only; the
		// token ledger rides the round events.
		const round1 = run.events[0];
		expect(round1.round.role).toBe("coder");
		expect(round1.round.tool_calls).toBeUndefined();
		expect(round1.round.usage.total_tokens).toBe(400_000);
		// The terminated call is its own standalone event.
		expect(run.events[1].calls).toMatchObject([{ call_id: "t-1", tool: "bash", status: "succeeded" }]);
		expect(Date.parse(run.events[1].calls[0].requested_at)).not.toBeNaN();
		expect(Date.parse(run.events[1].calls[0].result_at)).toBeGreaterThanOrEqual(
			Date.parse(run.events[1].calls[0].requested_at),
		);
		expect(run.events[1].role).toBe("coder");
		// The request that never terminated is emitted incomplete only once
		// the process has ENDED (it cannot be known incomplete while alive).
		expect(run.events[3].calls).toMatchObject([{ call_id: "t-2", tool: "bash", status: "incomplete" }]);
		expect(run.events[3].calls[0].result_at).toBeNull();

		// Liveness: the first three events were received while the inner
		// process was demonstrably still running (it sleeps 500ms after each
		// ledger write). A buffered-until-exit tailer fails here.
		expect(run.aliveAtEvent.slice(0, 3)).toEqual([true, true, true]);
		expect(run.aliveAtEvent[3]).toBe(false); // emitted after the process ended

		expect(await run.finished).toBe(0); // mirrors the inner process's natural exit
	}, 30_000);

	test("SIGTERM to the driver terminates the live inner Codeflow process", async () => {
		const run = await runDriver({ mode: "forever", intervalMs: 400, stopAfterRounds: 2 });
		await waitFor(
			() => run.events.filter((event) => event.type === "round").length >= 2,
			15_000,
			"two streamed rounds",
		);

		// Everything streamed so far was supervised while the process was alive.
		expect(run.aliveAtEvent.length).toBeGreaterThanOrEqual(2);
		for (const alive of run.aliveAtEvent) expect(alive).toBe(true);

		run.kill("SIGTERM"); // what the runner's budget stop does
		const code = await Promise.race([
			run.finished,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("driver did not exit after SIGTERM")), 15_000),
			),
		]);
		expect(Number.isInteger(code)).toBe(true);

		// The inner process is dead, terminated by the FORWARDED signal (a
		// dead process cannot write the marker), and it never finished its
		// endless script on its own.
		await waitFor(() => captureJson(run.capture, "inner-terminated") !== null, 5_000, "inner terminated marker");
		expect(captureJson(run.capture, "inner-natural-exit")).toBe(null);

		// The prompt reached the inner process through the real spawn form
		// `exec "<task>"`: projection fields only.
		const prompt = fs.readFileSync(path.join(run.capture, "inner-argv"), "utf8");
		expect(prompt.startsWith("exec ")).toBe(true);
		expect(prompt).toContain(PROJECTION.problem_statement);
		expect(prompt).toContain(PROJECTION.instance_id);
	}, 40_000);

	test("a non-zero inner exit code is mirrored by the driver", async () => {
		const run = await runDriver({ mode: "fail" });
		await run.finished;
		expect(await run.finished).toBe(3);
		// The round still streamed while the process was alive.
		expect(run.events.map((event) => event.type)).toEqual(["round"]);
		expect(run.aliveAtEvent[0]).toBe(true);
	}, 30_000);
});

describe("production defaults end to end: a cap terminates the live nested run", () => {
	test("model-rounds cap through the REAL CLI and driver script; partial patch graded", () => {
		const outDir = makeTmpDir("codeflow-bench-prodcap-");
		const capture = world.newCapture();
		// Everything real except the two live boundaries the host cannot serve
		// offline: the driver seam is NOT overridden (the PRODUCTION default
		// runtime/scripts/benchmark/codeflow-driver.ts runs), and only its inner
		// `codeflow` binary is the fake, streaming rounds forever.
		const env = world.env(capture);
		delete env.CODEFLOW_BENCHMARK_DRIVER_BIN;
		env.CODEFLOW_BENCHMARK_CODEFLOW_BIN = FAKE_INNER;
		env.FAKE_INNER_MODE = "forever";
		env.FAKE_INNER_INTERVAL_MS = "400";
		env.FAKE_INNER_CAPTURE_DIR = capture;

		const result = runCodeflow(
			[
				"benchmark", "run",
				"--dataset", world.snapshot,
				"--instances", writeInstancesFile([INSTANCE_RESOLVED]),
				"--out", outDir,
				"--budget", "model-rounds=2",
			],
			env,
			90_000,
		);
		expect(result.exitCode).toBe(0);

		const slug = INSTANCE_RESOLVED.replace(/\//g, "__");
		const attempt = readJson(path.join(outDir, "cases", slug, "case.json")).attempts[0];
		const manifest = readJson(path.join(outDir, "benchmark-run.json"));
		const report = readJson(path.join(outDir, "report.json"));
		const predictions = readJsonl(path.join(outDir, "predictions.jsonl"));

		// The cap terminated the attempt; a stop is not an execution failure.
		expect(attempt.terminated_by).toBe("model_rounds");
		expect(attempt.execution_status).toBe("completed");
		expect(attempt.metrics.model_rounds_total).toBe(2); // round 3 never streamed
		expect(manifest.budgets.effective.model_rounds).toBe(2);
		expect(report.budget_terminations.model_rounds).toBe(1);

		// Partial work before the stop is extracted and officially graded.
		expect(predictions).toHaveLength(1);
		expect(Object.keys(predictions[0]).sort()).toEqual(["instance_id", "model_name_or_path", "model_patch"]);
		expect(predictions[0].model_patch).toContain("STEP_1");
		expect(predictions[0].model_patch).not.toContain("STEP_2");
		expect(predictions[0].model_patch).not.toContain("STEP_3");
		expect(attempt.verdict).toBe("resolved");
		const harness = readJsonl(path.join(capture, "harness-calls.jsonl"));
		expect(harness).toHaveLength(1);
		expect(harness[0].official_fields_ok).toBe(true);
		expect(harness[0].run_id).toBe(attempt.evaluation_run_id);

		// The nested run was LIVE when the supervisor's signal landed: it never
		// finished its endless script, and at kill time the crossing round was
		// already durable in the runner-written ledger.
		const terminated = captureJson(capture, "inner-terminated");
		expect(terminated).not.toBe(null);
		expect(terminated.usage_rows).toBe(2);
		expect(captureJson(capture, "inner-natural-exit")).toBe(null);
		expect(pidAlive(Number(fs.readFileSync(path.join(capture, "inner-pid"), "utf8")))).toBe(false);
	}, 90_000);
});
