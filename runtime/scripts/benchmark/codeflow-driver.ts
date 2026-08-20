#!/usr/bin/env bun
/**
 * Production default for CODEFLOW_BENCHMARK_DRIVER_BIN (the seam contract in
 * tests/benchmark/fakes/README.md §1): a REAL Codeflow run per instance
 * attempt.
 *
 *   <this> --workspace <dir> --attempt <n> --model-config <id>
 *   stdin: exactly the model-visible instance projection (4 keys)
 *   stdout: NDJSON DriverEvents
 *
 * What it does per attempt:
 *  1. starts `codeflow exec "<task prompt>"` with cwd = the fresh
 *     repo@base_commit workspace, a FRESH Codeflow run id/session (run-scoped
 *     env is stripped), and run artifacts redirected OUTSIDE the workspace
 *     (attempt dir), so the extracted patch stays exactly the model's work;
 *  2. the benchmark-ledger extension (runtime/extensions/benchmark-ledger)
 *     appends attributed usage rows, privacy-safe tool-call rows, and failed
 *     provider attempts to a staging ledger under the attempt dir — real
 *     instrumentation, not transcript parsing;
 *  3. while the Codeflow process runs, this script TAILS the staging
 *     ledgers (poll cadence LIVE_POLL_MS) and streams them as DriverEvents
 *     as they land: each usage row is one round, each terminated tool call a
 *     `tool_calls` event attributed to the role that issued it — so the
 *     runner's budget checks supervise the LIVE run; after the process ends
 *     a bounded final drain picks up the last rows, and calls still without
 *     a terminal result at stream end are `incomplete`;
 *  4. SIGTERM is forwarded to the Codeflow process (budget stops terminate a
 *     live run), escalating to SIGKILL if it lingers past the runner's grace
 *     window; the exit code mirrors the Codeflow run (non-zero => the runner
 *     records infra_error).
 *
 * The inner `codeflow` binary is `runtime/bin/codeflow` by default and can be
 * substituted with CODEFLOW_BENCHMARK_CODEFLOW_BIN (same spawn form
 * `bash <bin> exec "<prompt>"`) — the offline seam the developer tests use
 * to prove this script's live streaming and signal forwarding without a
 * model or network (tests/benchmark/driver-streaming.test.ts).
 *
 * The prompt is built ONLY from the allowlist projection; evaluator-only data
 * never reaches argv, stdin, env, or any file this process writes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { toolNetworkWallEnv } from "../../lib/benchmark/tool-network";

const RUNTIME_DIR = path.resolve(import.meta.dir, "..", "..");
const CODEFLOW_BIN =
	process.env.CODEFLOW_BENCHMARK_CODEFLOW_BIN?.trim() || path.join(RUNTIME_DIR, "bin", "codeflow");

const RUN_SCOPED_ENV_KEYS = [
	"CODEFLOW_RUN_ID",
	"CODEFLOW_RUNS_DIR",
	"CODEFLOW_HANDOFF_ID",
	"CODEFLOW_GOAL_ID",
	"CODEFLOW_LANE",
	"CODEFLOW_AGENT_ROLE",
	"CODEFLOW_AGENT_DEPTH",
];

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index !== -1 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

async function readStdin(): Promise<string> {
	return await new Response(Bun.stdin.stream()).text();
}

function fail(message: string, code = 2): never {
	process.stderr.write(`codeflow-driver: ${message}\n`);
	process.exit(code);
}

const workspace = argValue("--workspace");
const attempt = argValue("--attempt") ?? "1";
const modelConfig = argValue("--model-config") ?? "default";
if (workspace === undefined) fail("--workspace <dir> is required");

const stdinText = await readStdin();
let projection: Record<string, unknown>;
try {
	projection = JSON.parse(stdinText) as Record<string, unknown>;
} catch {
	fail("stdin is not the model-visible instance projection JSON");
}
for (const key of ["instance_id", "repo", "base_commit", "problem_statement"]) {
	if (typeof projection[key] !== "string" || (projection[key] as string).length === 0) {
		fail(`stdin projection is missing the visible field '${key}'`);
	}
}

const attemptDir = path.resolve(workspace, "..");
const ledgerDir = path.join(attemptDir, "driver-ledger");
const runsDir = path.join(attemptDir, "codeflow-runs");
fs.mkdirSync(ledgerDir, { recursive: true });

/** The task prompt: ONLY projection fields reach the model. */
const prompt = [
	`Resolve SWE-bench task ${(projection.instance_id as string).trim()} in the repository at ` +
		`${(projection.repo as string).trim()}, which is checked out at commit ` +
		`${(projection.base_commit as string).trim()} in your working directory.`,
	"",
	"## Problem statement",
	"",
	(projection.problem_statement as string).trim(),
	"",
	"## Rules of engagement",
	"",
	"- Work directly in the current repository checkout; leave the repository as a working tree whose changes are the fix (uncommitted; the benchmark extracts `git diff`).",
	"- Do not use external network search to look up the answer, the gold patch, or issue threads about this task.",
	"- Keep the change minimal and consistent with the repository's conventions.",
].join("\n");

const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
for (const key of RUN_SCOPED_ENV_KEYS) delete childEnv[key];
// §4 tool-network wall: mechanically deny outbound network for the whole
// spawned Codeflow tree — root role here, delegated roles through
// role-launcher's { ...process.env } inheritance — while the run's
// configured provider endpoints (env-supplied base URLs, exactly) stay
// reachable. Environment is the mechanism: every stock HTTP client (curl,
// fetch, pip, git-over-http …) honors it with no tool-argument parsing, and
// an unlistening loopback proxy fails non-exempt attempts closed in
// milliseconds. This script exists only as the benchmark driver seam, so
// nothing outside benchmark mode is affected.
Object.assign(childEnv, toolNetworkWallEnv(childEnv));
childEnv.CODEFLOW_RUNS_DIR = runsDir;
childEnv.CODEFLOW_BENCHMARK_DRIVER_LEDGER_DIR = ledgerDir;
childEnv.CODEFLOW_BENCHMARK_ATTEMPT = attempt;
childEnv.CODEFLOW_BENCHMARK_MODEL_CONFIG = modelConfig;

const child = Bun.spawn(["bash", CODEFLOW_BIN, "exec", prompt], {
	cwd: workspace,
	stdin: "ignore",
	stdout: "ignore",
	stderr: "inherit",
	env: childEnv,
});

// Budget stops SIGTERM this process; forward to the live Codeflow run and let
// its own supervision terminate the role tree. Escalate to SIGKILL if it
// lingers, so the whole run dies inside the runner's grace window.
const TERMINATION_ESCALATE_MS = 3_000;
let terminating = false;
const forwardTermination = (): void => {
	if (terminating) return;
	terminating = true;
	try {
		child.kill("SIGTERM");
	} catch {
		/* already gone */
	}
	setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}, TERMINATION_ESCALATE_MS);
};
process.on("SIGTERM", forwardTermination);
process.on("SIGINT", forwardTermination);

function emit(event: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Incremental whole-line reader for one append-only ledger file. */
class LedgerTail {
	private offset = 0;
	private pending = "";
	constructor(private readonly file: string) {}
	lines(): string[] {
		let content: string;
		try {
			content = fs.readFileSync(this.file, "utf8");
		} catch {
			return [];
		}
		if (content.length <= this.offset) return [];
		const chunk = this.pending + content.slice(this.offset);
		this.offset = content.length;
		const lines = chunk.split("\n");
		this.pending = lines.pop() ?? "";
		return lines.filter((line) => line.trim().length > 0);
	}
}

const usageTail = new LedgerTail(path.join(ledgerDir, "usage.jsonl"));
const toolTail = new LedgerTail(path.join(ledgerDir, "tool-calls.jsonl"));
const failedTail = new LedgerTail(path.join(ledgerDir, "failed-model-attempts.jsonl"));

/** call_id -> the requested row still waiting for a terminal result. */
const pendingRequested = new Map<string, Record<string, unknown>>();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Consume every new ledger row, emitting DriverEvents; returns rows consumed. */
function streamLedgers(): number {
	let consumed = 0;
	for (const line of failedTail.lines()) {
		consumed++;
		const row = JSON.parse(line) as Record<string, unknown>;
		emit({
			type: "failed_model_attempt",
			attempt: {
				role: row.role,
				provider: row.provider,
				model: row.model,
				error_class: row.error_class,
			},
		});
	}
	for (const line of usageTail.lines()) {
		consumed++;
		const row = JSON.parse(line) as Record<string, unknown>;
		emit({
			type: "round",
			round: {
				role: row.role,
				provider: row.provider,
				model: row.model,
				handoff_id: row.handoff_id ?? null,
				goal_id: row.goal_id ?? null,
				lane: row.lane ?? null,
				usage: row.usage,
			},
		});
	}
	for (const line of toolTail.lines()) {
		consumed++;
		const row = JSON.parse(line) as Record<string, unknown>;
		if (row.kind === "requested") {
			pendingRequested.set(String(row.call_id), row);
			continue;
		}
		pendingRequested.delete(String(row.call_id));
		emit({
			type: "tool_calls",
			role: row.role,
			// Direct attribution from the staging row — the context that emitted
			// the call (design §7); never derived from the role.
			provider: row.provider,
			model: row.model,
			handoff_id: row.handoff_id ?? null,
			goal_id: row.goal_id ?? null,
			lane: row.lane ?? null,
			calls: [{ call_id: row.call_id, tool: row.tool, status: row.status }],
		});
	}
	return consumed;
}

/** Live supervision cadence: every row streams to the runner within this window. */
const LIVE_POLL_MS = 100;
/** Post-exit drain bound: the last rows can land right after exit is observed. */
const DRAIN_MAX_POLLS = 10;
const DRAIN_POLL_MS = 100;

let childExitCode: number | null | undefined; // undefined while the run is live
const childExited = child.exited.then(
	(code) => {
		childExitCode = code;
		return code;
	},
	() => {
		childExitCode = 1;
		return 1;
	},
);

// Stream WHILE the Codeflow process runs. The runner re-checks budgets after
// every event, so a cap fires on a LIVE run and SIGTERMs this process (which
// forwards to the Codeflow child) instead of grading a corpse after the fact.
while (childExitCode === undefined) {
	streamLedgers();
	await Promise.race([childExited, sleep(LIVE_POLL_MS)]);
}

// Final drain: bounded, exiting early once the ledgers stay quiet for two
// consecutive polls.
let quietPolls = 0;
for (let poll = 0; poll < DRAIN_MAX_POLLS && quietPolls < 2; poll++) {
	quietPolls = streamLedgers() > 0 ? 0 : quietPolls + 1;
	await sleep(DRAIN_POLL_MS);
}
streamLedgers();
// Calls that started but never produced a terminal result are incomplete.
for (const row of pendingRequested.values()) {
	emit({
		type: "tool_calls",
		role: row.role,
		provider: row.provider,
		model: row.model,
		handoff_id: row.handoff_id ?? null,
		goal_id: row.goal_id ?? null,
		lane: row.lane ?? null,
		calls: [{ call_id: row.call_id, tool: row.tool, status: "incomplete" }],
	});
}

process.exit(childExitCode === null || childExitCode === undefined ? 1 : childExitCode);
