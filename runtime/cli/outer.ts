#!/usr/bin/env bun
/**
 * The outer ring: Task-level `codeflow ls`, `sub`, `stop`, and `audit`.
 *
 * Everything here is about a whole Task, never about one Work Commitment.
 * Handoff closure, Recall, and mechanical evidence stay on the Worker-facing
 * `code-agent` surface.
 *
 * Output is one JSON object per line on stdout and diagnostics on stderr, so a
 * follower can read incrementally without waiting for a document to close.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { handoffHistory } from "../lib/handoff";
import { taskState } from "../lib/state";
import { probeAll } from "../lib/liveness";
import { DEFAULT_RUNS_DIR, RunPaths } from "../lib/paths";
import { scan, wait } from "../lib/wait";
import { buildUsageReport, readUsageRecords } from "../lib/usage";

/** Requirements are summarized for a table, not reproduced in it. */
const REQUIREMENT_WIDTH = 60;

export class OuterError extends Error {}

export type RunStatus = "running" | "finished" | "unknown";

export interface RunRow {
	task_id: string;
	status: RunStatus;
	duration_seconds: number | null;
	objective: string;
}

interface Runner {
	pid?: number;
	child_pid?: number;
	pgid?: number;
	started_at?: string;
	objective?: string;
}

function readRunner(runDir: string): Runner | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(runDir, "runner.json"), "utf-8")) as Runner;
	} catch {
		// No runner.json at all is a directory we cannot classify, not an error:
		// a run that died before its first write still deserves a row.
		return null;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists and belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function truncateObjective(text: string): string {
	if (text.length <= REQUIREMENT_WIDTH) return text;
	return text.slice(0, REQUIREMENT_WIDTH) + "...";
}

function seconds(fromIso: string | undefined, toMs: number): number | null {
	if (!fromIso) return null;
	const start = Date.parse(fromIso);
	if (Number.isNaN(start)) return null;
	return Math.max(0, Math.floor((toMs - start) / 1000));
}

/**
 * The watchdog's recorded exit for this run, if it wrote one.
 *
 * Deliberately not `readLiveness`: that helper requires a numeric `pid` inside
 * the record, but the pid is already in the filename and an exit record is
 * meaningful without it. Here the only question is "did something exit, and
 * when", so a record missing its pid still answers it.
 */
const LIVENESS_NAME = /^(?<pid>\d+)--(?<process>root|worker)\.json$/;

function readExit(
	livenessDir: string,
	runner: Runner,
): { exited_at?: string } | null {
	let names: string[];
	try {
		names = fs.readdirSync(livenessDir).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return null;
	}
	const expected = runner.child_pid ?? runner.pid;
	if (expected === undefined) return null;
	for (const name of names) {
		const match = LIVENESS_NAME.exec(name);
		try {
			const record = JSON.parse(fs.readFileSync(path.join(livenessDir, name), "utf-8")) as {
				pid?: number;
				process?: "root" | "worker";
				status?: string;
				exited_at?: string;
			};
			const pid = record.pid ?? (match?.groups ? Number.parseInt(match.groups.pid, 10) : undefined);
			const processKind = record.process ?? match?.groups?.process;
			if (record.status === "exited" && pid === expected && processKind === "root") return record;
		} catch {
			// A damaged heartbeat is one missing signal, not a failure.
		}
	}
	return null;
}

/**
 * Classify one Task from its runner and liveness records.
 *
 * A recorded exit outranks a pid probe: pids are reused, and the watchdog's
 * record is the only evidence that survives the process itself.
 */
export function classify(runsDir: string, runId: string, now = Date.now()): RunRow {
	const paths = new RunPaths(runsDir, runId);
	const runner = readRunner(paths.runDir);
	const objective = truncateObjective(runner?.objective ?? "");

	if (runner === null) {
		return { task_id: runId, status: "unknown", duration_seconds: null, objective };
	}

	const exited = readExit(paths.liveness, runner);
	if (exited) {
		const end = exited.exited_at ? Date.parse(exited.exited_at) : Number.NaN;
		return {
			task_id: runId,
			status: "finished",
			duration_seconds: seconds(runner.started_at, Number.isNaN(end) ? now : end),
			objective,
		};
	}

	const identities = [runner.pid, runner.child_pid, runner.pgid].filter(
		(pid): pid is number => typeof pid === "number",
	);
	const alive = identities.some((pid) => pidAlive(pid));
	return {
		task_id: runId,
		status: alive ? "running" : "finished",
		duration_seconds: seconds(runner.started_at, now),
		objective,
	};
}

/** Directories beginning with `_` are shared plumbing (`_spool`), not runs. */
export function listRunIds(runsDir: string): string[] {
	try {
		return fs
			.readdirSync(runsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

function ls(runsDir: string): number {
	for (const runId of listRunIds(runsDir)) {
		console.log(JSON.stringify(classify(runsDir, runId)));
	}
	return 0;
}

/**
 * Terminate a live Task's root runner.
 *
 * Refusing an already-finished run is deliberate: "stop" reporting success on
 * something it did not stop would make the command useless as evidence.
 */
function stop(runsDir: string, runId: string | undefined): number {
	if (!runId) throw new OuterError("stop requires a run id");

	const paths = new RunPaths(runsDir, runId);
	if (!fs.existsSync(paths.runDir)) throw new OuterError(`no such run: ${runId}`);

	const runner = readRunner(paths.runDir);
	if (runner === null || typeof runner.pid !== "number") {
		throw new OuterError(`run has no recorded runner: ${runId}`);
	}

	const row = classify(runsDir, runId);
	if (row.status !== "running") {
		throw new OuterError(`run is not running: ${runId} (${row.status})`);
	}

	try {
		const target = runner.pgid ?? runner.child_pid;
		if (target !== undefined) process.kill(-target, "SIGTERM");
		else process.kill(runner.pid, "SIGTERM");
		if (runner.pid !== target) process.kill(runner.pid, "SIGTERM");
	} catch (error) {
		throw new OuterError(`could not signal pid ${runner.pid}: ${(error as Error).message}`);
	}

	console.log(
		JSON.stringify({
			run_id: runId,
			stopped: true,
			pid: runner.pid,
			...(runner.child_pid !== undefined ? { child_pid: runner.child_pid } : {}),
			...(runner.pgid !== undefined ? { pgid: runner.pgid } : {}),
		}),
	);
	return 0;
}

interface SubArgs {
	runId: string;
	since: number;
	timeout: number;
	kinds: string[];
}

/**
 * The run id is positional and mandatory.
 *
 * Inferring "the only active run" would silently attach to the wrong one the
 * first time two runs overlap, so `ls` supplies the id and `sub` demands it.
 */
export function parseSub(argv: string[]): SubArgs {
	let runId: string | undefined;
	let since = 0;
	let timeout = 600;
	let kinds: string[] = [];

	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		const value = argv[index + 1];
		switch (token) {
			case "--since":
				since = Number.parseInt(value ?? "", 10);
				index++;
				break;
			case "--timeout":
				timeout = Number.parseInt(value ?? "", 10);
				index++;
				break;
			case "--kind":
				kinds = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
				index++;
				break;
			default:
				if (token.startsWith("--")) throw new OuterError(`unknown option: ${token}`);
				if (runId !== undefined) throw new OuterError(`unexpected argument: ${token}`);
				runId = token;
		}
	}

	if (!runId) throw new OuterError("sub requires a run id (use `codeflow ls` to find one)");
	if (!Number.isSafeInteger(since) || since < 0) {
		throw new OuterError("--since must be a non-negative integer");
	}
	if (!Number.isSafeInteger(timeout) || timeout < 0) {
		throw new OuterError("--timeout must be a non-negative integer");
	}
	return { runId, since, timeout, kinds };
}

async function sub(runsDir: string, argv: string[]): Promise<number> {
	const args = parseSub(argv);
	const result = await wait({
		runsDir,
		runId: args.runId,
		since: args.since,
		kinds: args.kinds,
		timeoutSeconds: args.timeout,
	});
	console.log(JSON.stringify(result, null, 2));
	return 0;
}

function goals(runsDir: string, argv: string[]): number {
	const [runId] = argv;
	if (!runId) throw new OuterError("goals requires a run id");
	if (runId.startsWith("--")) throw new OuterError(`unknown option: ${runId}`);
	const paths = new RunPaths(runsDir, runId);
	if (!fs.existsSync(paths.runDir)) throw new OuterError(`no such run: ${runId}`);
	console.log(JSON.stringify(taskState(paths), null, 2));
	return 0;
}

function usage(runsDir: string, argv: string[]): number {
	const [runId] = argv;
	if (!runId) throw new OuterError("usage requires a run id");
	if (runId.startsWith("--")) throw new OuterError(`unknown option: ${runId}`);
	if (argv.length > 1) throw new OuterError(`unexpected argument: ${argv[1]}`);

	const paths = new RunPaths(runsDir, runId);
	if (!fs.existsSync(paths.runDir)) throw new OuterError(`no such run: ${runId}`);
	console.log(JSON.stringify(buildUsageReport(runId, readUsageRecords(paths)), null, 2));
	return 0;
}

interface AuditArgs {
	runId?: string;
	force: boolean;
}

function parseAudit(argv: string[]): AuditArgs {
	let runId: string | undefined;
	let force = false;
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (token === "--force") {
			force = true;
			continue;
		}
		if (token.startsWith("--")) throw new OuterError(`unknown option: ${token}`);
		if (runId !== undefined) throw new OuterError(`unexpected argument: ${token}`);
		runId = token;
	}
	if (!runId) throw new OuterError("audit requires a run id");
	return { runId, force };
}

function auditHandoffs(paths: RunPaths): Array<{
	id: string;
	goal_id: string;
	status: string;
	receipt_id: string | null;
}> {
	const rows = handoffHistory(paths);
	return rows.map((view) => ({
		id: view.handoff.id,
		goal_id: view.handoff.goal_id,
		status: view.status,
		receipt_id: view.receipt?.id ?? null,
	}));
}

function auditWorkers(paths: RunPaths): Array<{
	pid: number;
	process: "root" | "worker" | null;
	verdict: "ALIVE" | "DEAD" | "UNKNOWN";
	heartbeat_age_seconds: number | null;
}> {
	return probeAll(paths.liveness).map((probe) => ({
		pid: probe.pid,
		process: probe.process ?? null,
		verdict: probe.verdict,
		heartbeat_age_seconds: probe.heartbeatAgeSeconds,
	}));
}

function lastEventIdentity(paths: RunPaths): {
	seq: number;
	subject: string;
	kind: string;
	status: string;
} | null {
	const events = scan(paths.events, 0, []).events;
	const event = events.at(-1);
	return event
		? { seq: event.seq, subject: event.subject, kind: event.kind, status: event.status }
		: null;
}

function audit(runsDir: string, argv: string[]): number {
	const args = parseAudit(argv);
	const paths = new RunPaths(runsDir, args.runId as string);
	if (!fs.existsSync(paths.runDir)) throw new OuterError(`no such run: ${args.runId}`);

	const runner = readRunner(paths.runDir);
	const row = classify(runsDir, args.runId as string);
	const handoffs = auditHandoffs(paths);
	const hasBlocked = handoffs.some((handoff) => handoff.status === "blocked");
	const hasActive = handoffs.some((handoff) => handoff.status === "open" || handoff.status === "running");

	let trigger: "blocked" | "dead_runner" | "missing_runner" | "forced";
	if (hasBlocked) trigger = "blocked";
	else if (runner === null && hasActive) trigger = "missing_runner";
	else if (row.status !== "running" && hasActive) trigger = "dead_runner";
	else if (args.force) trigger = "forced";
	else {
		throw new OuterError("audit refused: run is healthy and progressing; use --force only when a human asked");
	}

	console.log(
		JSON.stringify({
			run_id: args.runId,
			trigger,
			run_status: row.status,
			forced: args.force,
			handoffs,
			workers: auditWorkers(paths),
			last_event: lastEventIdentity(paths),
		}),
	);
	return 0;
}

export async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	const runsDir = process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR;

	try {
		switch (command) {
			case "ls":
				return ls(runsDir);
			case "sub":
				return await sub(runsDir, rest);
			case "goals":
				return goals(runsDir, rest);
			case "usage":
				return usage(runsDir, rest);
			case "stop":
				return stop(runsDir, rest[0]);

			case "audit":
				return audit(runsDir, rest);

			default:
				throw new OuterError(`unknown command: ${command ?? "(none)"}`);
		}
	} catch (error) {
		if (error instanceof OuterError) {
			console.error(`codeflow ${command ?? ""}: error: ${error.message}`.replace("  ", " "));
			return 1;
		}
		throw error;
	}
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
