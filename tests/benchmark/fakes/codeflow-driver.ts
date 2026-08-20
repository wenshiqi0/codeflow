#!/usr/bin/env bun
/**
 * Test-support fake of the real-mode Codeflow driver process
 * (tests/benchmark/fakes/README.md §1 — the seam contract).
 *
 * Spawned by the benchmark runner as:
 *   <this> --workspace <dir> --attempt <n> --model-config <id>
 * with the model-visible instance projection (4 keys) on stdin.
 *
 * Emits NDJSON DriverEvents (contract §1.7) on stdout, one per line.
 * SIGTERM => write driver-terminated-<pid> and exit 0 (the runner must
 * terminate a budget-stopped process; SIGKILL-only supervision leaves no
 * marker and fails the acceptance test).
 *
 * Modes (FAKE_DRIVER_MODE):
 * - script:   play per-instance steps from FAKE_DRIVER_SCRIPT
 * - marathon: emit budget-sized rounds forever (REAL-13 kill supervision)
 * - silent:   write partial work, then emit nothing forever (REAL-20 proves
 *             wall-time supervision does not depend on another event)
 * - stream:   the PRODUCTION event protocol from runtime/scripts/benchmark/
 *             codeflow-driver.ts — rounds carry NO tool_calls; every tool
 *             call arrives as its own standalone `tool_calls` event. Before
 *             each emission the process OBSERVES the runner-written attempt
 *             ledgers (usage.jsonl / tool-calls.jsonl one dir above its
 *             workspace) and records the row counts + timestamp, so the
 *             acceptance tests can prove the runner streams ledgers to disk
 *             while this process is still alive (REAL-16..19).
 *
 * Every mode writes driver-natural-exit-<pid> when it finishes its script on
 * its own; only a supervisor's signal can prevent that marker, which is what
 * the budget tests assert (killed before natural exit, i.e. it would
 * otherwise have continued).
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface DriverStep {
	event?: unknown;
	sleep_ms?: number;
	write?: Record<string, string>;
}

interface DriverScript {
	instances: Record<string, { steps: DriverStep[] }>;
}

const pid = process.pid;

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1];
	return undefined;
}

/** --workspace <dir> per the contract; a lone positional is accepted as a fallback. */
const workspace =
	argValue("--workspace") ??
	process.argv.slice(2).find((token) => !token.startsWith("--") && token.includes(path.sep)) ??
	process.cwd();
const attempt = argValue("--attempt") ?? "1";
const modelConfig = argValue("--model-config") ?? "default";

/** Read stdin with a cap: a runner that never closes stdin cannot hang the fake. */
async function readStdin(maxMs = 5_000): Promise<string> {
	const chunks: Uint8Array[] = [];
	let done = false;
	const reader = (async () => {
		try {
			for await (const chunk of Bun.stdin.stream()) chunks.push(chunk as Uint8Array);
		} catch {
			/* stream closed */
		}
		done = true;
	})();
	const timer = new Promise<void>((resolve) => setTimeout(resolve, maxMs));
	await Promise.race([reader, timer]);
	if (done) return Buffer.concat(chunks).toString("utf8");
	return Buffer.concat(chunks).toString("utf8"); // partial read after the cap
}

function emit(event: unknown): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

function captureDir(): string | undefined {
	const dir = process.env.FAKE_CAPTURE_DIR;
	if (dir) fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function git(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args]);
	return result.exitCode === 0 ? result.stdout.toString().trim() : "";
}

const stdinText = await readStdin();

let instanceId = "unknown/unknown";
try {
	const parsed = JSON.parse(stdinText);
	instanceId = typeof parsed.instance_id === "string" ? parsed.instance_id : instanceId;
} catch {
	/* unparsable stdin: keep "unknown/unknown"; the leakage test fails on this */
}

const capture = captureDir();
if (capture) {
	// Everything this process received, for the leakage + workspace assertions.
	fs.writeFileSync(
		path.join(capture, `driver-spawn-${pid}.json`),
		JSON.stringify(
			{
				pid,
				argv: process.argv.slice(2),
				stdin: stdinText,
				env: process.env,
				workspace,
				attempt,
				model_config: modelConfig,
				workspace_head: fs.existsSync(workspace) ? git(workspace, ["rev-parse", "HEAD"]) : null,
			},
			null,
			0,
		),
		"utf8",
	);
	fs.writeFileSync(path.join(capture, `driver-pid-${pid}`), String(pid), "utf8");
}

/*
 * Ledger observation (stream mode): this process is the thing being
 * supervised, so what it can see of the runner's ledgers while still running
 * is exactly the "streamed incrementally before exit" evidence. The attempt
 * dir is one level above the workspace — the same derivation the production
 * driver uses for its staging ledgers.
 */
const attemptDir = path.resolve(workspace, "..");
const runnerUsageLedger = path.join(attemptDir, "usage.jsonl");
const runnerToolLedger = path.join(attemptDir, "tool-calls.jsonl");

function countRows(file: string): number {
	try {
		return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0).length;
	} catch {
		return 0;
	}
}

function observeLedgers(phase: string): void {
	if (!capture) return;
	fs.appendFileSync(
		path.join(capture, `driver-ledger-observations-${pid}.jsonl`),
		`${JSON.stringify({
			pid,
			phase,
			usage_rows: countRows(runnerUsageLedger),
			tool_rows: countRows(runnerToolLedger),
			at: new Date().toISOString(),
		})}\n`,
		"utf8",
	);
}

let emittedSeq = 0;

function emitObserved(event: unknown): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
	if (!capture) return;
	emittedSeq += 1;
	const type = (event as Record<string, unknown>).type;
	fs.appendFileSync(
		path.join(capture, `driver-emitted-${pid}.jsonl`),
		`${JSON.stringify({ pid, seq: emittedSeq, type, at: new Date().toISOString() })}\n`,
		"utf8",
	);
}

function markNaturalExit(summary: Record<string, unknown>): void {
	if (!capture) return;
	fs.writeFileSync(
		path.join(capture, `driver-natural-exit-${pid}`),
		JSON.stringify({ pid, at: new Date().toISOString(), ...summary }),
		"utf8",
	);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		// Still alive at termination time: record what the runner's ledgers
		// held the moment the supervisor's signal arrived.
		if ((process.env.FAKE_DRIVER_MODE ?? "script") === "stream") {
			observeLedgers(`sigterm`);
		}
		const dir = capture ?? process.env.FAKE_CAPTURE_DIR;
		if (dir) {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				path.join(dir, `driver-terminated-${pid}`),
				JSON.stringify({ pid, signal, at: new Date().toISOString() }),
				"utf8",
			);
		}
		process.exit(0);
	});
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function writeWorkspace(files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const target = path.join(workspace, rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content, "utf8");
	}
}

const mode = process.env.FAKE_DRIVER_MODE ?? "script";

if (mode === "marathon") {
	// Emit budget-sized rounds forever: one write after each round's sleep, so
	// a cap must stop a LIVE process mid-flight and the extracted patch holds
	// only the work that finished before the stop.
	const delayMs = Number(process.env.FAKE_MARATHON_DELAY_MS ?? 600);
	const tokens = Number(process.env.FAKE_MARATHON_TOKENS ?? 500_000);
	const toolsPerRound = Number(process.env.FAKE_MARATHON_TOOLS ?? 1);
	const maxRounds = Number(process.env.FAKE_MARATHON_MAX_ROUNDS ?? 10_000);
	for (let round = 1; round <= maxRounds; round++) {
		emit({
			type: "round",
			round: {
				role: "coder",
				provider: "fake-anthropic",
				model: "fake-marathon",
				usage: {
					input: tokens - 100,
					output: 100,
					reasoning: 0,
					cache_read: 0,
					cache_write: 0,
					total_tokens: tokens,
					cost: null,
				},
				tool_calls: Array.from({ length: toolsPerRound }, (_, i) => ({
					call_id: `m-${round}-${i}`,
					tool: "bash",
					status: "succeeded",
				})),
			},
		});
		await sleep(delayMs);
		writeWorkspace({ [`step-${round}.py`]: `STEP_${round} = True\n` });
	}
	markNaturalExit({ mode: "marathon", rounds: maxRounds });
	process.exit(0);
}

if (mode === "silent") {
	writeWorkspace({ "silent-partial.py": "SILENT_PARTIAL = True\n" });
	for (;;) await sleep(60_000);
}

if (mode === "stream") {
	// The production protocol (runtime/scripts/benchmark/codeflow-driver.ts):
	// a `round` event carries usage only — NO attached tool_calls — and every
	// tool call that terminates is its own standalone `tool_calls` event, so
	// tool-call budgets supervise the live process without waiting for the
	// next model response. Before EVERY emission this process records what the
	// runner's ledgers hold: if the runner buffered events and flushed ledgers
	// only at exit, every observation would show 0 rows and REAL-16 fails.
	const delayMs = Number(process.env.FAKE_STREAM_DELAY_MS ?? 350);
	const rounds = Number(process.env.FAKE_STREAM_ROUNDS ?? 4);
	const toolsPerRound = Number(process.env.FAKE_STREAM_TOOLS_PER_ROUND ?? 2);
	const tokens = Number(process.env.FAKE_STREAM_TOKENS ?? 400_000);
	let toolEvents = 0;
	for (let round = 1; round <= rounds; round++) {
		observeLedgers(`before_round_${round}`);
		emitObserved({
			type: "round",
			round: {
				role: "coder",
				provider: "fake-anthropic",
				model: "fake-stream",
				handoff_id: null,
				goal_id: null,
				lane: null,
				usage: {
					input: tokens - 100,
					output: 100,
					reasoning: 0,
					cache_read: 0,
					cache_write: 0,
					total_tokens: tokens,
					cost: null,
				},
			},
		});
		await sleep(delayMs);
		// Partial work exists from the moment a round lands, so every cap stop
		// below has a non-empty partial patch to extract.
		writeWorkspace({ [`step-${round}.py`]: `STEP_${round} = True\n` });
		await sleep(delayMs);
		for (let tool = 1; tool <= toolsPerRound; tool++) {
			observeLedgers(`before_tool_${round}_${tool}`);
			emitObserved({
				type: "tool_calls",
				role: "coder",
				// Same staging-row attribution the production chain forwards:
				// provider/model of the round that emitted these calls.
				provider: "fake-anthropic",
				model: "fake-stream",
				handoff_id: null,
				goal_id: null,
				lane: null,
				calls: [{ call_id: `s-${round}-${tool}`, tool: "bash", status: "succeeded" }],
			});
			toolEvents += 1;
			await sleep(delayMs);
		}
	}
	observeLedgers("before_exit");
	markNaturalExit({ mode: "stream", rounds, tool_events: toolEvents });
	process.exit(0);
}

// Script mode: play the per-instance step list from FAKE_DRIVER_SCRIPT.
let script: DriverScript = { instances: {} };
const scriptPath = process.env.FAKE_DRIVER_SCRIPT;
if (scriptPath && fs.existsSync(scriptPath)) {
	try {
		script = JSON.parse(fs.readFileSync(scriptPath, "utf8")) as DriverScript;
	} catch {
		script = { instances: {} };
	}
}
const instance = script.instances[instanceId];
const steps: DriverStep[] = instance?.steps ?? [
	// Unknown instance: one minimal valid round so the chain still completes.
	{
		event: {
			type: "round",
			round: {
				role: "coder",
				provider: "fake-openai",
				model: "fake-coder",
				usage: { input: 90, output: 10, reasoning: 0, cache_read: 0, cache_write: 0, total_tokens: 100, cost: null },
				tool_calls: [{ call_id: "fallback-1", tool: "bash", status: "succeeded" }],
			},
		},
	},
];

for (const step of steps) {
	if (step.event !== undefined) emit(step.event);
	if (step.sleep_ms) await sleep(step.sleep_ms);
	if (step.write) writeWorkspace(step.write);
}
markNaturalExit({ mode: "script", steps: steps.length });
process.exit(0);
