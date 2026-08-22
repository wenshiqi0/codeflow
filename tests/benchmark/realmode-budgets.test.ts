/**
 * Budgets must supervise a LIVE spawned process in real mode (design §4, §5,
 * §13.7): when a cap fires the runner stops pulling driver events, terminates
 * the process (SIGTERM first), still extracts the partial patch, still
 * submits the prediction, and still requests a verdict — a budget stop never
 * forces `unresolved` and never discards work.
 *
 * The marathon fake driver emits budget-sized rounds forever and writes one
 * workspace file after each round's sleep, so the only way these runs finish
 * is real supervision killing a real process mid-flight.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTmpDirs, makeTmpDir, readJson, readJsonl, runCodeflow, writeInstancesFile } from "./helpers";
import {
	buildRealmodeWorld,
	driverSpawns,
	INSTANCE_RESOLVED,
	pidAlive,
	type RealmodeWorld,
} from "./realmode-world";

let world: RealmodeWorld;

beforeAll(() => {
	world = buildRealmodeWorld();
}, 60_000);

afterAll(cleanupTmpDirs);

interface StopOutcome {
	result: ReturnType<typeof runCodeflow>;
	attempt: any;
	manifest: any;
	patch: string;
	spawn: Record<string, any>;
	terminatedMarker: boolean;
	/** Present iff the marathon process finished its whole script on its own. */
	naturalExitMarker: boolean;
}

/**
 * One marathon run: the driver would run ~forever; the given budget override
 * must stop it deterministically. DELAY_MS is generous so the kill always
 * lands inside the post-round sleep (the next write never happens).
 */
function stopRun(
	budget: string,
	marathon: { delayMs: number; tokens?: number; tools?: number },
	driverMode: "marathon" | "silent" = "marathon",
): StopOutcome {
	const outDir = makeTmpDir("codeflow-bench-rmbudget-");
	const capture = world.newCapture();
	const result = runCodeflow(
		[
			"benchmark", "run",
			"--dataset", world.snapshot,
			"--instances", writeInstancesFile([INSTANCE_RESOLVED]),
			"--out", outDir,
			"--budget", budget,
			...(budget.startsWith("fresh-") ? [] : ["--budget", "fresh-tokens=1000000000"]),
		],
		world.env(capture, { driverMode, marathon }),
		60_000,
	);
	if (result.exitCode !== 0) {
		throw new Error(`real-mode budget run failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`);
	}
	const attempt = readJson(
		path.join(outDir, "cases", INSTANCE_RESOLVED.replace(/\//g, "__"), "case.json"),
	).attempts[0];
	const manifest = readJson(path.join(outDir, "benchmark-run.json"));
	const patch = readJsonl(path.join(outDir, "predictions.jsonl"))[0].model_patch;
	const spawns = driverSpawns(capture);
	const spawn = spawns[0] ?? {};
	const terminatedMarker = fs
		.readdirSync(capture)
		.some((name) => name.startsWith("driver-terminated-"));
	const naturalExitMarker = fs
		.readdirSync(capture)
		.some((name) => name.startsWith("driver-natural-exit-"));
	return { result, attempt, manifest, patch, spawn, terminatedMarker, naturalExitMarker };
}

function expectSupervisedStop(outcome: StopOutcome, cap: string): void {
	// The process was live and is now dead, terminated by the runner.
	expect(Number(outcome.spawn.pid)).toBeGreaterThan(0);
	expect(pidAlive(Number(outcome.spawn.pid))).toBe(false);
	expect(outcome.terminatedMarker).toBe(true); // SIGTERM reached it, not SIGKILL-only
	// It had NOT finished its script (a completing process always writes the
	// natural-exit marker): the kill preempted a process that would otherwise
	// have kept emitting rounds. Non-vacuous: stream-mode REAL-16 proves the
	// marker IS written on natural completion.
	expect(outcome.naturalExitMarker).toBe(false);
	// The stop is recorded and never masquerades as a model result.
	expect(outcome.attempt.terminated_by).toBe(cap);
	expect(outcome.attempt.execution_status).toBe("completed");
	expect(outcome.attempt.verdict).toBe("resolved"); // the fake harness still graded the partial patch
	expect(outcome.patch).not.toBe("");
}

describe("REAL-13: each cap stops a live spawned process and still extracts the patch", () => {
	test("model-rounds cap", () => {
		const outcome = stopRun("model-rounds=2", { delayMs: 600 });
		expectSupervisedStop(outcome, "model_rounds");
		expect(outcome.attempt.metrics.model_rounds_total).toBe(2); // round 3 never happened
		expect(outcome.manifest.budgets.effective.model_rounds).toBe(2);
		// Partial patch: work that finished before the stop is in, later work is not.
		expect(outcome.patch).toContain("STEP_1");
		expect(outcome.patch).not.toContain("STEP_3");
	});

	test("tool-calls cap stops after the response that crossed it", () => {
		const outcome = stopRun("tool-calls=3", { delayMs: 600, tools: 2 });
		expectSupervisedStop(outcome, "tool_calls");
		expect(outcome.attempt.metrics.model_rounds_total).toBe(2);
		expect(outcome.attempt.metrics.tool_calls_total).toBe(4);
	});

	test("provider-reported token cap", () => {
		const outcome = stopRun("total-tokens=1000000", { delayMs: 600, tokens: 500_000 });
		expectSupervisedStop(outcome, "total_tokens");
		expect(outcome.attempt.metrics.model_rounds_total).toBe(2);
		expect(outcome.attempt.metrics.tokens.total_tokens).toBe(1_000_000);
	});

	test("wall-time safety stop on the real clock", () => {
		// Round 1 lands ~0s, STEP_1 at ~1.2s, round 2 immediately after;
		// the independent timer fires at 2s before STEP_2 or round 3.
		const outcome = stopRun("wall-seconds=2", { delayMs: 1_200 });
		expectSupervisedStop(outcome, "wall_seconds");
		expect(outcome.attempt.metrics.model_rounds_total).toBe(2);
		expect(outcome.attempt.metrics.wall_seconds).toBeGreaterThanOrEqual(2);
		expect(outcome.patch).toContain("STEP_1"); // partial work still extracted on a real-clock stop
		expect(outcome.patch).not.toContain("STEP_3");
	});

	test("wall-time safety stop interrupts a silent process without waiting for another event", () => {
		const outcome = stopRun("wall-seconds=1", { delayMs: 60_000 }, "silent");
		expectSupervisedStop(outcome, "wall_seconds");
		expect(outcome.attempt.metrics.model_rounds_total).toBe(0);
		expect(outcome.attempt.metrics.wall_seconds).toBeGreaterThanOrEqual(1);
		expect(outcome.patch).toContain("SILENT_PARTIAL");
	});
});
