/**
 * Real-mode process seams (contract §1.7, tests/benchmark/fakes/README.md).
 *
 * Real mode (`benchmark run` WITHOUT `--fixture`) drives a REAL Codeflow
 * process per instance attempt, provisions the workspace from the dataset
 * source repo at `base_commit`, and asks the official SWE-bench harness for
 * verdicts. Everything external is a spawned command behind four environment
 * variables so acceptance tests can substitute process-level fakes offline:
 *
 * - CODEFLOW_BENCHMARK_DRIVER_BIN      (the Codeflow process)
 * - CODEFLOW_BENCHMARK_HARNESS_BIN     (the official evaluator)
 * - CODEFLOW_BENCHMARK_REPO_CLONE_BIN  (workspace provisioning)
 * - CODEFLOW_BENCHMARK_DATASET_FETCH_BIN (hub dataset resolution)
 *
 * Each seam has an explicit production default under benchmark/scripts
 * (the live boundary: real model credentials, network, Docker, and the
 * official harness itself). Tests never exercise the production defaults —
 * they pin the seam contract, which both sides implement.
 *
 * Driver protocol (fakes/README §1): spawn
 *   <bin> --workspace <dir> --attempt <n> --model-config <id>
 * with exactly the model-visible instance projection (4 keys) on stdin, then
 * read NDJSON DriverEvents lazily from stdout, re-checking budgets after every
 * event. On a budget stop the runner stops reading and the generator's cleanup
 * sends SIGTERM, escalating to SIGKILL after a grace period. Non-zero exit
 * after a natural end is an execution infra_error — never retried in-attempt,
 * never disguised as unresolved.
 *
 * Evaluator protocol (fakes/README §2): spawn
 *   <bin> --predictions <file> --run-id <id> --instance <instanceId>
 * stdout's last non-empty line is the verdict token; exit 127 means evaluator
 * unavailable (=> not_evaluated, reported as unexecuted external
 * verification); any other failure is infra_error.
 *
 * Provisioning protocol (fakes/README §3): spawn
 *   <bin> <repo> <base_commit> <workspaceDir>
 * postcondition: workspaceDir is a git working tree whose HEAD is exactly
 * base_commit. The runner never mutates the dataset cache, any source clone,
 * or Codeflow's own checkouts — provisioning only writes inside the attempt's
 * workspace directory.
 *
 * Hub fetch protocol (fakes/README §4): spawn
 *   <bin> <hub-id>
 * stdout is one complete snapshot document carrying the exact resolved 40-hex
 * revision; a movable alias is rejected by the loader, loudly.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	BenchmarkCodeflowDriver,
	BenchmarkEvaluator,
	BenchmarkVerdict,
	DriverEvent,
	DriverRound,
	DriverToolCall,
	PredictionEntry,
} from "./driver";
import type { ModelVisibleInstance } from "./dataset";
import type { AttemptUsage, AttemptUsageCost } from "../../runtime/lib/observability/model-usage";

export const BENCHMARK_DRIVER_BIN_ENV = "CODEFLOW_BENCHMARK_DRIVER_BIN";
export const BENCHMARK_HARNESS_BIN_ENV = "CODEFLOW_BENCHMARK_HARNESS_BIN";
export const BENCHMARK_REPO_CLONE_BIN_ENV = "CODEFLOW_BENCHMARK_REPO_CLONE_BIN";
export const BENCHMARK_DATASET_FETCH_BIN_ENV = "CODEFLOW_BENCHMARK_DATASET_FETCH_BIN";

/** Production defaults for the four seams (the live boundary). */
const BENCHMARK_ROOT = path.resolve(import.meta.dir, "..");
export const BENCHMARK_SCRIPTS_DIR = path.join(BENCHMARK_ROOT, "scripts");

export function defaultDriverBin(): string[] {
	return [process.execPath, path.join(BENCHMARK_SCRIPTS_DIR, "codeflow-driver.ts")];
}
export function defaultHarnessBin(): string[] {
	return [path.join(BENCHMARK_SCRIPTS_DIR, "swebench-harness.sh")];
}
export function defaultRepoCloneBin(): string[] {
	return [path.join(BENCHMARK_SCRIPTS_DIR, "repo-clone.sh")];
}
export function defaultDatasetFetchBin(): string[] {
	return [process.execPath, path.join(BENCHMARK_SCRIPTS_DIR, "hub-fetch.ts")];
}

function envBin(name: string, fallback: () => string[]): string[] {
	const value = process.env[name];
	return value && value.trim() !== "" ? [value] : fallback();
}

export class BenchmarkProcessError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BenchmarkProcessError";
	}
}

/* ------------------------------------------------------------------ *
 * DriverEvent parsing: a spawned process is not a trusted module, so
 * every stdout line is structurally validated before it can become an
 * event. Malformed lines are a protocol violation (infra_error), never
 * silently skipped.
 * ------------------------------------------------------------------ */

const TERMINAL_TOOL_STATUSES = new Set(["succeeded", "failed", "rejected", "incomplete"]);
const VERDICT_TOKENS = new Set(["resolved", "unresolved", "infra_error", "not_evaluated"]);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** Explicit 0 is data; absent/null/NaN means "provider did not report". */
function cacheField(usage: Record<string, unknown>, camel: string, snake: string): number | null {
	const raw = camel in usage ? usage[camel] : usage[snake];
	return finiteNumber(raw);
}

function parseCost(value: unknown): AttemptUsageCost | null {
	if (!isObject(value)) return null;
	return {
		input: finiteNumber(value.input) ?? 0,
		output: finiteNumber(value.output) ?? 0,
		cache_read: finiteNumber(value.cacheRead ?? value.cache_read) ?? 0,
		cache_write: finiteNumber(value.cacheWrite ?? value.cache_write) ?? 0,
		total: finiteNumber(value.total) ?? 0,
	};
}

function parseUsage(value: unknown): AttemptUsage | null {
	if (!isObject(value)) return null;
	const input = finiteNumber(value.input);
	const output = finiteNumber(value.output);
	const reasoning = finiteNumber(value.reasoning) ?? 0;
	const cacheRead = cacheField(value, "cacheRead", "cache_read");
	const cacheWrite = cacheField(value, "cacheWrite", "cache_write");
	const reportedTotal = finiteNumber(value.totalTokens ?? value.total_tokens);
	if (input === null || output === null) return null;
	// Provider-reported total is the budget axis; when a provider omits it the
	// rounded sum of the reported components is the only honest stand-in.
	const total = reportedTotal ?? input + output + (cacheRead ?? 0) + (cacheWrite ?? 0);
	return {
		input,
		output,
		reasoning,
		cache_read: cacheRead,
		cache_write: cacheWrite,
		total_tokens: total,
		cost: parseCost(value.cost),
	};
}

function parseToolCalls(value: unknown): DriverToolCall[] | null {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) return null;
	const calls: DriverToolCall[] = [];
	for (const raw of value) {
		if (!isObject(raw)) return null;
		const callId = nonEmptyString(raw.call_id);
		const tool = nonEmptyString(raw.tool);
		const status = nonEmptyString(raw.status);
		const requestedAt = optionalString(raw.requested_at);
		const resultAt = optionalString(raw.result_at);
		if (
			callId === null ||
			tool === null ||
			status === null ||
			!TERMINAL_TOOL_STATUSES.has(status) ||
			(requestedAt !== null && Number.isNaN(Date.parse(requestedAt))) ||
			(resultAt !== null && Number.isNaN(Date.parse(resultAt)))
		) {
			return null;
		}
		if (status === "incomplete" && resultAt !== null) return null;
		calls.push({
			call_id: callId,
			tool,
			status: status as DriverToolCall["status"],
			...(requestedAt === null ? {} : { requested_at: requestedAt }),
			...(raw.result_at === undefined ? {} : { result_at: resultAt }),
		});
	}
	return calls;
}

function optionalNonnegativeInteger(value: unknown): number | null {
	if (value === undefined || value === null) return null;
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : -1;
}

function parseRound(value: unknown): DriverRound | null {
	if (!isObject(value)) return null;
	const role = nonEmptyString(value.role);
	const provider = nonEmptyString(value.provider);
	const model = nonEmptyString(value.model);
	const usage = parseUsage(value.usage);
	const depth = optionalNonnegativeInteger(value.depth);
	const turn = optionalNonnegativeInteger(value.turn);
	const requestStartedAt = optionalString(value.request_started_at);
	const respondedAt = optionalString(value.at);
	const runId = optionalString(value.run_id);
	if (
		role === null ||
		provider === null ||
		model === null ||
		usage === null ||
		depth === -1 ||
		turn === -1 ||
		(requestStartedAt !== null && Number.isNaN(Date.parse(requestStartedAt)))
		|| (respondedAt !== null && Number.isNaN(Date.parse(respondedAt)))
	) {
		return null;
	}
	const toolCalls = parseToolCalls(value.tool_calls);
	if (toolCalls === null) return null;
	return {
		role,
		provider,
		model,
		depth,
		turn,
		...(respondedAt === null ? {} : { at: respondedAt }),
		run_id: runId,
		request_started_at: requestStartedAt,
		handoff_id: optionalString(value.handoff_id),
		goal_id: optionalString(value.goal_id),
		lane: optionalString(value.lane),
		usage,
		tool_calls: toolCalls,
	};
}

/** A driver workspace write must stay inside the workspace (no traversal). */
function safeRelativePath(value: unknown): string | null {
	const text = nonEmptyString(value);
	if (text === null) return null;
	if (path.isAbsolute(text)) return null;
	const normalized = path.normalize(text);
	if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) return null;
	return normalized;
}

/**
 * Structurally validate one parsed stdout JSON document as a DriverEvent.
 * Returns null when the document is not a valid event (protocol violation).
 */
export function parseDriverEvent(value: unknown): DriverEvent | null {
	if (!isObject(value)) return null;
	switch (value.type) {
		case "round": {
			const round = parseRound(value.round);
			return round === null ? null : { type: "round", round };
		}
		case "tool_calls": {
			const role = nonEmptyString(value.role);
			const provider = nonEmptyString(value.provider);
			const model = nonEmptyString(value.model);
			const calls = parseToolCalls(value.calls);
			if (role === null || provider === null || model === null || calls === null || calls.length === 0) {
				return null;
			}
			return {
				type: "tool_calls",
				role,
				provider,
				model,
				handoff_id: optionalString(value.handoff_id),
				goal_id: optionalString(value.goal_id),
				lane: optionalString(value.lane),
				calls,
			};
		}
		case "failed_model_attempt": {
			const attempt = isObject(value.attempt) ? value.attempt : null;
			if (attempt === null) return null;
			const role = nonEmptyString(attempt.role);
			const provider = nonEmptyString(attempt.provider);
			const model = nonEmptyString(attempt.model);
			const errorClass = nonEmptyString(attempt.error_class);
			if (role === null || provider === null || model === null || errorClass === null) return null;
			return {
				type: "failed_model_attempt",
				attempt: { role, provider, model, error_class: errorClass },
			};
		}
		case "workspace_write": {
			const file = safeRelativePath(value.path);
			const content = typeof value.content === "string" ? value.content : null;
			if (file === null || content === null) return null;
			return { type: "workspace_write", path: file, content };
		}
		case "infra_error": {
			const errorClass = nonEmptyString(value.error_class);
			return errorClass === null ? null : { type: "infra_error", error_class: errorClass };
		}
		case "budget_stop":
			return value.budget === "wall_seconds"
				? { type: "budget_stop", budget: "wall_seconds" }
				: null;
		default:
			return null;
	}
}

/* ------------------------------------------------------------------ *
 * Line reading / process termination
 * ------------------------------------------------------------------ */

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
		buffer += decoder.decode();
		if (buffer.length > 0) yield buffer;
	} finally {
		try {
			await reader.cancel();
		} catch {
			// The stream may already be closed with the process.
		}
	}
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Drain a piped child stdout/stderr fully ("pipe" streams only). */
async function readAll(stream: number | ReadableStream<Uint8Array> | undefined): Promise<string> {
	if (stream === undefined || typeof stream === "number") return "";
	return await new Response(stream).text();
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * SIGTERM first — the process is expected to exit promptly — then SIGKILL
 * after the grace period. Budget-stop supervision must terminate a live
 * process; SIGKILL-only supervision would discard in-flight cleanup.
 */
export async function terminateProcess(child: Bun.Subprocess, graceMs: number): Promise<void> {
	const pid = child.pid;
	if (pid === undefined || !pidAlive(pid)) return;
	try {
		child.kill("SIGTERM");
	} catch {
		return;
	}
	await Promise.race([child.exited, sleep(graceMs)]);
	if (pidAlive(pid)) {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}
	try {
		await child.exited;
	} catch {
		// Reaping must not mask the attempt outcome.
	}
}

/* ------------------------------------------------------------------ *
 * The real Codeflow driver process
 * ------------------------------------------------------------------ */

export interface ProcessCodeflowDriverOptions {
	/** Command prefix; default: the driver seam or the production script. */
	bin?: string[];
	/** SIGTERM→SIGKILL escalation window; default 5000ms. */
	killGraceMs?: number;
	/** Child environment; default: inherit (model credentials pass through). */
	env?: Record<string, string | undefined>;
}

/**
 * One spawned Codeflow process per attempt. stdin carries ONLY the allowlist
 * projection; stdout is consumed lazily so budgets re-check after every event;
 * breaking out of the event loop (budget stop) terminates the process.
 */
export function createProcessCodeflowDriver(
	options: ProcessCodeflowDriverOptions = {},
): BenchmarkCodeflowDriver {
	const bin = options.bin ?? envBin(BENCHMARK_DRIVER_BIN_ENV, defaultDriverBin);
	const graceMs = options.killGraceMs ?? 5_000;
	const env = options.env;

	return {
		async *startAttempt(input) {
			let child: Bun.Subprocess;
			try {
				child = Bun.spawn(
					[
						...bin,
						"--workspace",
						input.workspaceDir,
						"--attempt",
						String(input.attempt),
						"--model-config",
						input.modelConfig,
					],
					{ stdin: "pipe", stdout: "pipe", stderr: "inherit", env: env ?? process.env },
				);
			} catch (error) {
				yield {
					type: "infra_error",
					error_class: `driver_spawn_failed:${(error as Error).name}`,
				};
				return;
			}
			let wallExpired = false;
			const remainingWallMs = Math.max(0, input.wallDeadlineMs - input.clock.now());
			const wallTimer = setTimeout(() => {
				wallExpired = true;
				// Closing the child also closes stdout, waking a reader that is
				// blocked during model/tool silence. The production child forwards
				// SIGTERM to the full Codeflow tree.
				void terminateProcess(child, graceMs);
			}, remainingWallMs);

			// Exactly one JSON document — the projection and nothing else.
			const stdin = child.stdin;
			if (stdin !== undefined && typeof stdin !== "number") {
				try {
					stdin.write(`${JSON.stringify(input.instance)}\n`);
					stdin.end();
				} catch {
					// The process may have exited before reading stdin; its exit
					// code decides the outcome below.
				}
			}

			let protocolViolation = false;
			try {
				for await (const line of streamLines(child.stdout)) {
					if (line.trim() === "") continue;
					let parsed: unknown;
					try {
						parsed = JSON.parse(line);
					} catch {
						protocolViolation = true;
						break;
					}
					const event = parseDriverEvent(parsed);
					if (event === null) {
						protocolViolation = true;
						break;
					}
					yield event;
				}
				// Natural end (stdout closed): give the process a moment to exit on
				// its own so a finishing child is not SIGTERMed into an infra_error.
				await Promise.race([child.exited, sleep(graceMs)]);
			} finally {
				clearTimeout(wallTimer);
				// Budget stop, error, or a hung natural end: never leave a live child.
				await terminateProcess(child, graceMs);
			}

			if (wallExpired) {
				yield { type: "budget_stop", budget: "wall_seconds" };
				return;
			}

			if (protocolViolation) {
				yield { type: "infra_error", error_class: "driver_protocol_violation" };
				return;
			}
			const code = await child.exited;
			if (code !== 0) {
				// Execution infrastructure failure: no silent in-attempt retry,
				// never an unresolved. The attempt keeps its partial work.
				yield { type: "infra_error", error_class: `driver_exit_${code}` };
			}
		},
	};
}

/* ------------------------------------------------------------------ *
 * The official SWE-bench harness evaluator
 * ------------------------------------------------------------------ */

export interface ProcessHarnessEvaluatorOptions {
	/** Command prefix; default: the harness seam or the production wrapper. */
	bin?: string[];
	/** Child environment; default: inherit. */
	env?: Record<string, string | undefined>;
}

function lastVerdictToken(stdout: string): BenchmarkVerdict | null {
	const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
	if (lines.length === 0) return null;
	const token = lines[lines.length - 1];
	return VERDICT_TOKENS.has(token) ? (token as BenchmarkVerdict) : null;
}

/**
 * One harness process per evaluated attempt with the attempt's unique
 * evaluation run id. Exit 127 (evaluator unavailable, e.g. no Docker) maps to
 * not_evaluated — reported as unexecuted external verification, never a
 * fabricated verdict; any other failure is infra_error.
 */
export function createProcessHarnessEvaluator(
	options: ProcessHarnessEvaluatorOptions = {},
): BenchmarkEvaluator {
	const bin = options.bin ?? envBin(BENCHMARK_HARNESS_BIN_ENV, defaultHarnessBin);
	const env = options.env;
	return {
		async evaluate(request): Promise<BenchmarkVerdict> {
			let predictionsFile = request.predictionsFile ?? null;
			if (predictionsFile === null) {
				// Standalone use: write the single prediction where the child
				// can read it. The normal path reuses the attempt's file.
				predictionsFile = path.join(
					fsMkdtemp(),
					"predictions.jsonl",
				);
				writePredictionLine(predictionsFile, request.prediction);
			}
			let child: Bun.Subprocess;
			try {
				child = Bun.spawn(
					[
						...bin,
						"--predictions",
						predictionsFile,
						"--run-id",
						request.evaluationRunId,
						"--instance",
						request.instanceId,
					],
					{ stdout: "pipe", stderr: "pipe", env: env ?? process.env },
				);
			} catch (error) {
				console.error(`codeflow benchmark: evaluator could not start: ${(error as Error).message}`);
				return "infra_error";
			}
			const stdout = await readAll(child.stdout);
			const stderr = await readAll(child.stderr);
			const code = await child.exited;
			if (code === 127) {
				// Evaluator unavailable on this host: docker/toolchain missing.
				// Not a model result and not an execution failure — the
				// attempt simply has no official verdict yet.
				if (stderr.trim().length > 0) {
					console.error(`codeflow benchmark: evaluator unavailable: ${stderr.trim().slice(0, 300)}`);
				}
				return "not_evaluated";
			}
			if (code !== 0) {
				console.error(
					`codeflow benchmark: evaluator failed (exit ${code}): ${stderr.trim().slice(0, 300)}`,
				);
				return "infra_error";
			}
			const verdict = lastVerdictToken(stdout);
			if (verdict === null) {
				console.error(
					`codeflow benchmark: evaluator produced no verdict token: ${stdout.trim().slice(-300)}`,
				);
				return "infra_error";
			}
			return verdict;
		},
	};
}

/* ------------------------------------------------------------------ *
 * Workspace provisioning (repo@base_commit from the dataset source repo)
 * ------------------------------------------------------------------ */

export type BenchmarkWorkspaceProvisioner = (
	instance: ModelVisibleInstance,
	workspaceDir: string,
) => void;

export interface SourceCloneProvisionerOptions {
	/** Command prefix; default: the clone seam or the production script. */
	bin?: string[];
	/** Child environment; default: inherit. */
	env?: Record<string, string | undefined>;
}

/**
 * Provision a fresh isolated workspace whose HEAD is exactly the instance's
 * base_commit, cloned from the dataset `repo`. Never writes anywhere outside
 * the workspace directory; a provisioning failure is an attempt infra_error.
 */
export function createSourceCloneWorkspaceProvisioner(
	options: SourceCloneProvisionerOptions = {},
): BenchmarkWorkspaceProvisioner {
	const bin = options.bin ?? envBin(BENCHMARK_REPO_CLONE_BIN_ENV, defaultRepoCloneBin);
	const env = options.env;
	return (instance, workspaceDir) => {
		const result = Bun.spawnSync([...bin, instance.repo, instance.base_commit, workspaceDir], {
			stdout: "pipe",
			stderr: "pipe",
			env: env ?? process.env,
		});
		if (result.exitCode !== 0) {
			const tail = new TextDecoder().decode(result.stderr).trim().slice(-400);
			throw new BenchmarkProcessError(
				`workspace provisioning failed for ${instance.instance_id} ` +
					`(repo ${instance.repo} at ${instance.base_commit}, exit ${result.exitCode})` +
					(tail.length > 0 ? `: ${tail}` : ""),
			);
		}
	};
}

/* ------------------------------------------------------------------ *
 * Hub dataset resolution
 * ------------------------------------------------------------------ */

export interface HubFetchOptions {
	/** Command prefix; default: the fetch seam or the production script. */
	bin?: string[];
	/** Child environment; default: inherit. */
	env?: Record<string, string | undefined>;
}

/**
 * Resolve a hub dataset id (`owner/name`) to its snapshot document by
 * spawning `<bin> <hub-id>`; stdout must be one complete snapshot JSON
 * document. The caller validates it exactly like a local snapshot.
 */
export function fetchHubDatasetDocument(hubId: string, options: HubFetchOptions = {}): string {
	const bin = options.bin ?? envBin(BENCHMARK_DATASET_FETCH_BIN_ENV, defaultDatasetFetchBin);
	const result = Bun.spawnSync([...bin, hubId], {
		stdout: "pipe",
		stderr: "pipe",
		env: options.env ?? process.env,
	});
	if (result.exitCode !== 0) {
		const tail = new TextDecoder().decode(result.stderr).trim().slice(-400);
		throw new BenchmarkProcessError(
			`hub dataset resolution failed for '${hubId}' (exit ${result.exitCode ?? "signal"})` +
				(tail.length > 0 ? `: ${tail}` : ""),
		);
	}
	const stdout = new TextDecoder().decode(result.stdout).trim();
	if (stdout.length === 0) {
		throw new BenchmarkProcessError(`hub dataset resolution for '${hubId}' produced no document`);
	}
	return stdout;
}

function fsMkdtemp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-bench-eval-"));
}

function writePredictionLine(file: string, prediction: PredictionEntry): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(prediction)}\n`, "utf8");
}
