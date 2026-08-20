/**
 * Real-mode STREAMING supervision through the production process seam
 * (design §4, §5; contract §1.7, §1.7.1).
 *
 * REAL-13 (realmode-budgets.test.ts) proves post-mortem that a budget stop
 * kills the spawned process and still grades the partial patch. What it
 * cannot see — and what design §4/§1.7.1 actually require — is that the
 * runner CONSUMES the nested process's event stream lazily and lands the
 * model-round / tool-call / token ledgers on disk WHILE that process is
 * still alive. A runner that buffered stdout and flushed ledgers at exit
 * would pass every existing assertion and still violate the contract
 * (budgets could not supervise a live process; a crash would lose the
 * ledger).
 *
 * Evidence strategy (process-level, no `.codeflow/runs/` reads): the fake
 * driver's `stream` mode speaks the PRODUCTION event protocol of
 * runtime/scripts/benchmark/codeflow-driver.ts — rounds carry usage only,
 * every terminated tool call is its own standalone `tool_calls` event — and
 * the nested process itself observes the runner-written attempt ledgers
 * (usage.jsonl / tool-calls.jsonl one dir above its workspace) before each
 * emission, while it is demonstrably still alive (it emits the next event,
 * or its SIGTERM handler runs later). Recorded under FAKE_CAPTURE_DIR:
 *
 *   driver-ledger-observations-<pid>.jsonl  {phase, usage_rows, tool_rows, at}
 *   driver-emitted-<pid>.jsonl              {seq, type, at}
 *   driver-natural-exit-<pid>               written only on natural completion
 *   driver-terminated-<pid>                 written only by the SIGTERM handler
 *
 * A process that finished on its own always writes the natural-exit marker;
 * only the supervisor's signal can preempt it. So "terminated marker present
 * AND natural-exit marker absent AND fewer events emitted than scripted"
 * proves the kill landed on a live process that would otherwise have
 * continued.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	cleanupTmpDirs,
	makeTmpDir,
	readJson,
	readJsonl,
	runCodeflow,
	writeInstancesFile,
} from "./helpers";
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

interface StreamOptions {
	/** e.g. "model-rounds=2"; omitted => natural end under default budgets. */
	budget?: string;
	/** Scripted rounds in the stream fake; default 4. */
	rounds?: number;
	/** Standalone tool_calls events per round; default 2. */
	toolsPerRound?: number;
	/** Provider-reported total_tokens per round; default 400_000. */
	tokens?: number;
	/** Sleep between stream steps; default 350ms. */
	delayMs?: number;
}

interface StreamOutcome {
	attempt: any;
	manifest: any;
	report: any;
	predictions: any[];
	patch: string;
	spawn: Record<string, any>;
	observations: any[];
	emitted: any[];
	/** SIGTERM marker JSON — present iff the supervisor terminated a LIVE process. */
	terminated: any | null;
	/** Natural-exit marker JSON — present iff the process finished its script. */
	naturalExit: any | null;
	harness: any[];
	outDir: string;
	rounds: number;
	toolsPerRound: number;
}

function captureFile(capture: string, prefix: string): string | null {
	if (!fs.existsSync(capture)) return null;
	const match = fs.readdirSync(capture).find((name) => name.startsWith(prefix));
	return match === undefined ? null : path.join(capture, match);
}

function readRows(file: string | null): any[] {
	return file !== null && fs.existsSync(file) ? readJsonl(file) : [];
}

function marker(capture: string, kind: "driver-terminated" | "driver-natural-exit"): any | null {
	const file = captureFile(capture, kind);
	return file !== null ? readJson(file) : null;
}

function streamRun(options: StreamOptions = {}): StreamOutcome {
	const rounds = options.rounds ?? 4;
	const toolsPerRound = options.toolsPerRound ?? 2;
	const outDir = makeTmpDir("codeflow-bench-rmstream-");
	const capture = world.newCapture();
	const args = [
		"benchmark", "run",
		"--dataset", world.snapshot,
		"--instances", writeInstancesFile([INSTANCE_RESOLVED]),
		"--out", outDir,
	];
	if (options.budget !== undefined) args.push("--budget", options.budget);
	const result = runCodeflow(
		args,
		world.env(capture, {
			driverMode: "stream",
			stream: {
				rounds,
				toolsPerRound,
				tokens: options.tokens,
				delayMs: options.delayMs,
			},
		}),
		90_000,
	);
	if (result.exitCode !== 0) {
		throw new Error(
			`real-mode stream run failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
		);
	}
	const slug = INSTANCE_RESOLVED.replace(/\//g, "__");
	return {
		attempt: readJson(path.join(outDir, "cases", slug, "case.json")).attempts[0],
		manifest: readJson(path.join(outDir, "benchmark-run.json")),
		report: readJson(path.join(outDir, "report.json")),
		predictions: readJsonl(path.join(outDir, "predictions.jsonl")),
		patch: readJsonl(path.join(outDir, "predictions.jsonl"))[0].model_patch,
		spawn: driverSpawns(capture)[0] ?? {},
		observations: readRows(captureFile(capture, "driver-ledger-observations-")),
		emitted: readRows(captureFile(capture, "driver-emitted-")),
		terminated: marker(capture, "driver-terminated"),
		naturalExit: marker(capture, "driver-natural-exit"),
		harness: readRows(captureFile(capture, "harness-calls.jsonl")),
		outDir,
		rounds,
		toolsPerRound,
	};
}

function phase(outcome: StreamOutcome, name: string): any {
	const row = outcome.observations.find((observation) => observation.phase === name);
	if (row === undefined) {
		throw new Error(
			`the live process never recorded observation '${name}'; recorded phases: ` +
				outcome.observations.map((observation) => observation.phase).join(", "),
		);
	}
	return row;
}

/**
 * The kill landed on a LIVE process that would otherwise have continued:
 * - SIGTERM reached it (a dead process cannot write the terminated marker);
 * - it had NOT finished its script (natural-exit marker is what a process
 *   that ran to completion always writes);
 * - it emitted fewer events than its script held;
 * - its last ledger observation precedes its termination.
 */
function expectKilledAliveAndWouldContinue(outcome: StreamOutcome): void {
	expect(Number(outcome.spawn.pid)).toBeGreaterThan(0);
	expect(pidAlive(Number(outcome.spawn.pid))).toBe(false); // no leaked live process after the run
	expect(outcome.terminated).not.toBe(null);
	expect(outcome.naturalExit).toBe(null);
	const totalEvents = outcome.rounds * (1 + outcome.toolsPerRound);
	expect(outcome.emitted.length).toBeGreaterThan(1);
	expect(outcome.emitted.length).toBeLessThan(totalEvents);
	const lastObservation = outcome.observations[outcome.observations.length - 1];
	expect(Date.parse(outcome.terminated.at)).toBeGreaterThanOrEqual(Date.parse(lastObservation.at));
}

/**
 * A budget stop never discards work and never masquerades as a model result
 * (design §4, §5): the partial patch is extracted, submitted with exactly the
 * official keys, and the evaluator is still asked with the attempt's unique
 * evaluation run id.
 */
function expectPartialPatchEvaluated(outcome: StreamOutcome, contain: string[], notContain: string[]): void {
	expect(outcome.predictions).toHaveLength(1);
	const prediction = outcome.predictions[0];
	expect(Object.keys(prediction).sort()).toEqual(["instance_id", "model_name_or_path", "model_patch"]);
	expect(prediction.instance_id).toBe(INSTANCE_RESOLVED);
	for (const fragment of contain) expect(outcome.patch).toContain(fragment);
	for (const fragment of notContain) expect(outcome.patch).not.toContain(fragment);
	expect(outcome.harness).toHaveLength(1);
	expect(outcome.harness[0].instance).toBe(INSTANCE_RESOLVED);
	expect(outcome.harness[0].official_fields_ok).toBe(true);
	expect(outcome.harness[0].run_id).toBe(outcome.attempt.evaluation_run_id);
	expect(outcome.attempt.verdict).toBe("resolved"); // the fake harness graded the partial patch
	expect(outcome.attempt.execution_status).toBe("completed"); // a stop is not an execution failure
}

describe("REAL-16: the production process seam streams ledgers while the nested process is alive", () => {
	test("natural end under default budgets: every ledger row is on disk before the process exits", () => {
		const outcome = streamRun({ rounds: 3 });
		// The process finished its script on its own; nobody terminated it.
		expect(outcome.naturalExit).not.toBe(null);
		expect(outcome.terminated).toBe(null);
		expect(outcome.attempt.terminated_by).toBe(null);
		expect(outcome.attempt.execution_status).toBe("completed");
		expect(outcome.attempt.verdict).toBe("resolved");

		// While ALIVE (it went on to emit the next event / exit later), the
		// process observed the runner's ledgers already reflecting every
		// processed event. A runner that flushes ledgers at exit shows 0 here.
		const beforeRound2 = phase(outcome, "before_round_2");
		expect(beforeRound2.usage_rows).toBe(1); // round 1's usage+token row
		expect(beforeRound2.tool_rows).toBe(4); // 2 standalone tool events x (requested+result)
		const beforeRound3 = phase(outcome, "before_round_3");
		expect(beforeRound3.usage_rows).toBe(2);
		expect(beforeRound3.tool_rows).toBe(8);
		const beforeTool12 = phase(outcome, "before_tool_1_2");
		expect(beforeTool12.usage_rows).toBe(1);
		expect(beforeTool12.tool_rows).toBe(2); // the FIRST tool event's rows landed before the second was emitted
		const beforeExit = phase(outcome, "before_exit");
		expect(beforeExit.usage_rows).toBe(3); // the FULL ledger preceded the process's own exit
		expect(beforeExit.tool_rows).toBe(12);

		// Alive evidence: observations strictly precede the later emissions
		// and the natural exit recorded by the same process.
		const roundsEmitted = outcome.emitted.filter((event) => event.type === "round");
		expect(roundsEmitted).toHaveLength(3);
		expect(Date.parse(beforeRound2.at)).toBeLessThanOrEqual(Date.parse(roundsEmitted[1].at));
		expect(Date.parse(beforeExit.at)).toBeLessThanOrEqual(Date.parse(outcome.naturalExit.at));

		// Metrics agree with what the live process watched stream to disk.
		expect(outcome.attempt.metrics.model_rounds_total).toBe(3);
		expect(outcome.attempt.metrics.tool_calls_total).toBe(6);
		expect(outcome.attempt.metrics.tokens.total_tokens).toBe(1_200_000); // 3 x 400_000 token ledger
	}, 60_000);

	test("the attempt ledgers on disk hold exactly the streamed rows", () => {
		const outcome = streamRun({ rounds: 2, toolsPerRound: 1 });
		const attemptDir = path.join(
			outcome.outDir,
			"cases",
			INSTANCE_RESOLVED.replace(/\//g, "__"),
			"attempts",
			"1",
		);
		const usageRows = readJsonl(path.join(attemptDir, "usage.jsonl"));
		const toolRows = readJsonl(path.join(attemptDir, "tool-calls.jsonl"));
		// 1 usage row per streamed round; each standalone tool event is one
		// call = a requested + a result row. These are the same counts the live
		// process observed streaming in (REAL-16 first test).
		expect(usageRows).toHaveLength(2);
		expect(toolRows).toHaveLength(4); // 2 calls x (requested + result)
		for (const row of usageRows) {
			expect(row.usage.total_tokens).toBe(400_000); // the token ledger axis
			expect(row.role).toBe("coder");
		}
		expect(outcome.attempt.metrics.model_rounds_total).toBe(2);
		expect(outcome.attempt.metrics.tool_calls_total).toBe(2); // calls, not rows
		expect(phase(outcome, "before_exit").usage_rows).toBe(2);
		expect(phase(outcome, "before_exit").tool_rows).toBe(4);
	}, 60_000);
});

describe("REAL-17: the model-round cap kills the live process; the partial patch is still graded", () => {
	test("stop after round 2 with the crossing round already durable on the ledger", () => {
		const outcome = streamRun({ budget: "model-rounds=2", rounds: 4 });

		expectKilledAliveAndWouldContinue(outcome);
		expect(outcome.attempt.terminated_by).toBe("model_rounds");
		// Round 2 was applied, round 3 was never emitted: stop exactly at the cap.
		expect(outcome.attempt.metrics.model_rounds_total).toBe(2);
		expect(outcome.emitted.filter((event) => event.type === "round")).toHaveLength(2);
		expect(outcome.emitted[outcome.emitted.length - 1].type).toBe("round");
		// Only round 1's standalone tool events were emitted before the stop.
		expect(outcome.attempt.metrics.tool_calls_total).toBe(2);
		// The moment the supervisor's SIGTERM arrived, the crossing round was
		// already durably in the ledgers — not lost with the killed process.
		expect(phase(outcome, "sigterm").usage_rows).toBe(2);
		expect(phase(outcome, "sigterm").tool_rows).toBe(4);
		// Partial work before the stop is submitted and graded; later work is not.
		expectPartialPatchEvaluated(outcome, ["STEP_1"], ["STEP_2", "STEP_3", "STEP_4"]);
		expect(outcome.manifest.budgets.effective.model_rounds).toBe(2);
		expect(outcome.report.budget_terminations.model_rounds).toBe(1);
	}, 60_000);
});

describe("REAL-18: the tool-call cap fires on the standalone instrumentation event", () => {
	test("stop between model responses — no second round is needed or emitted", () => {
		const outcome = streamRun({ budget: "tool-calls=2", rounds: 4 });

		expectKilledAliveAndWouldContinue(outcome);
		expect(outcome.attempt.terminated_by).toBe("tool_calls");
		// Contract §1.7: tool-call budgets supervise the live process WITHOUT
		// waiting for the next model response. The stop fired on the second
		// standalone tool_calls event; exactly one round was ever emitted.
		expect(outcome.emitted.filter((event) => event.type === "round")).toHaveLength(1);
		expect(outcome.emitted[outcome.emitted.length - 1].type).toBe("tool_calls");
		expect(outcome.attempt.metrics.model_rounds_total).toBe(1);
		expect(outcome.attempt.metrics.tool_calls_total).toBe(2);
		// The first tool event's rows were on the ledger while the process
		// was still alive, before it emitted the second one.
		expect(phase(outcome, "before_tool_1_2").tool_rows).toBe(2);
		expect(phase(outcome, "sigterm").usage_rows).toBe(1);
		expect(phase(outcome, "sigterm").tool_rows).toBe(4);
		expectPartialPatchEvaluated(outcome, ["STEP_1"], ["STEP_2", "STEP_3", "STEP_4"]);
		expect(outcome.report.budget_terminations.tool_calls).toBe(1);
	}, 60_000);
});

describe("REAL-19: the provider-reported token cap kills the live process; the partial patch is still graded", () => {
	test("stop at round 3 (1.2M >= 1M) with the crossing round fully counted", () => {
		const outcome = streamRun({ budget: "total-tokens=1000000", rounds: 4, tokens: 400_000 });

		expectKilledAliveAndWouldContinue(outcome);
		expect(outcome.attempt.terminated_by).toBe("total_tokens");
		// The token ledger counts the crossing round in full — 3 x 400_000.
		expect(outcome.attempt.metrics.model_rounds_total).toBe(3);
		expect(outcome.attempt.metrics.tokens.total_tokens).toBe(1_200_000);
		expect(outcome.emitted.filter((event) => event.type === "round")).toHaveLength(3);
		expect(phase(outcome, "sigterm").usage_rows).toBe(3);
		expect(phase(outcome, "sigterm").tool_rows).toBe(8);
		// Rounds 1 and 2 finished their writes; round 3's write never landed.
		expectPartialPatchEvaluated(outcome, ["STEP_1", "STEP_2"], ["STEP_3", "STEP_4"]);
		expect(outcome.manifest.budgets.effective.total_tokens).toBe(1_000_000);
		expect(outcome.report.budget_terminations.total_tokens).toBe(1);
	}, 60_000);
});
