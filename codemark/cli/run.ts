#!/usr/bin/env bun
/** Run one root-Agent-only measurement of an Issue's initial organization. */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgentArgv, ConfigError, resolveAgent } from "../../runtime/lib/config";
import { nowIso, writeJsonAtomic } from "../../runtime/lib/paths";
import {
	attachOrganizationUsage,
	createInitialOrganization,
	CodemarkOrganizationError,
	finalizeOrganization,
	publishInitialOrganization,
	readInitialOrganization,
} from "../lib/organization";

export const VERSION = "0.1.0";
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const USAGE_SCHEMA_VERSION = 1;

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..", "..");
const RUNTIME_DIR = path.join(PACKAGE_ROOT, "runtime");
const CONFIG_FILE = path.join(RUNTIME_DIR, "config.json");
const TOOL_ALLOWLIST = ["read", "collaborate"] as const;
const EXTENSIONS = [
	path.join(RUNTIME_DIR, "extensions", "provider-profiles", "index.ts"),
	path.join(PACKAGE_ROOT, "codemark", "extensions", "organization", "index.ts"),
	path.join(PACKAGE_ROOT, "codemark", "extensions", "context", "index.ts"),
];
const DIAGNOSTIC_LIMIT = 2_000;
const POST_EXIT_DRAIN_GRACE_MS = 1_000;

export class CodemarkError extends Error {}

export interface CodemarkArguments {
	issue?: string;
	model?: string;
	outDir?: string;
	timeoutSeconds: number;
	help: boolean;
	version: boolean;
}

export interface RunOptions {
	stdin?: string;
	cwd?: string;
	now?: Date;
}

interface UsageCost {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	total: number;
}

export interface CodemarkUsageTotals {
	calls: number;
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	reasoning: number;
	total_tokens: number;
	cost: UsageCost;
}

interface CodemarkUsageRecord {
	schema_version: number;
	at: string;
	run_id: string;
	process_kind: "manager";
	turn: number;
	provider: string;
	model: string;
	response_model: string;
	usage: Omit<CodemarkUsageTotals, "calls">;
}

interface CodemarkUsageReport {
	schema_version: number;
	run_id: string;
	generated_at: string;
	records: CodemarkUsageRecord[];
	models: Array<{ provider: string; model: string } & CodemarkUsageTotals>;
	total: CodemarkUsageTotals;
}

interface ManagerObservation {
	stopReason?: string;
	errorMessage?: string;
	stderrTail: string;
	usageRecords: CodemarkUsageRecord[];
}

interface Cutoff {
	kind: "timeout" | "interrupted";
	at: string;
	atMs: number;
}

export function usage(): string {
	return [
		"usage: codemark [options] [\"<issue>\"]",
		"",
		"Run the configured Codeflow Agent until its first natural turn end, recording only its",
		"initial organization frontier. No child Agent is started.",
		"",
		"  --model <provider/model>          override the configured Agent model",
		"  --out <dir>                       exact output directory for this run",
		"  --timeout <seconds>               wall-clock limit (default: 300)",
		"  --help                            show this help",
		"  --version                         show the Codemark version",
		"",
		"When no issue argument is supplied, codemark reads the issue from stdin.",
		"The default output is $CODEFLOW_HOME/codemark/runs/<run-id>.",
	].join("\n");
}

function takeValue(argv: string[], index: number, flag: string): string {
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) throw new CodemarkError(`${flag} requires a value`);
	return value;
}

function parsePositiveInteger(value: string, flag: string): number {
	if (!/^[1-9][0-9]*$/.test(value)) throw new CodemarkError(`${flag} requires a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new CodemarkError(`${flag} requires a positive integer`);
	return parsed;
}

/** Parse without touching stdin, credentials, the filesystem, or a provider. */
export function parseArguments(argv: string[]): CodemarkArguments {
	const issueParts: string[] = [];
	let model: string | undefined;
	let outDir: string | undefined;
	let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
	let timeoutSeen = false;
	let help = false;
	let version = false;
	let positionalOnly = false;

	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (positionalOnly) {
			issueParts.push(value);
			continue;
		}
		if (value === "--") {
			positionalOnly = true;
			continue;
		}
		if (value === "-h" || value === "--help") {
			help = true;
			continue;
		}
		if (value === "--version") {
			version = true;
			continue;
		}
		if (value === "--model") {
			if (model !== undefined) throw new CodemarkError("--model may be specified only once");
			model = takeValue(argv, index, value);
			index += 1;
			continue;
		}
		if (value.startsWith("--model=")) {
			if (model !== undefined) throw new CodemarkError("--model may be specified only once");
			model = value.slice("--model=".length);
			if (!model) throw new CodemarkError("--model requires a value");
			continue;
		}
		if (value === "--out") {
			if (outDir !== undefined) throw new CodemarkError("--out may be specified only once");
			outDir = takeValue(argv, index, value);
			index += 1;
			continue;
		}
		if (value.startsWith("--out=")) {
			if (outDir !== undefined) throw new CodemarkError("--out may be specified only once");
			outDir = value.slice("--out=".length);
			if (!outDir) throw new CodemarkError("--out requires a value");
			continue;
		}
		if (value === "--timeout") {
			if (timeoutSeen) throw new CodemarkError("--timeout may be specified only once");
			timeoutSeconds = parsePositiveInteger(takeValue(argv, index, value), value);
			timeoutSeen = true;
			index += 1;
			continue;
		}
		if (value.startsWith("--timeout=")) {
			if (timeoutSeen) throw new CodemarkError("--timeout may be specified only once");
			timeoutSeconds = parsePositiveInteger(value.slice("--timeout=".length), "--timeout");
			timeoutSeen = true;
			continue;
		}
		if (value.startsWith("-")) throw new CodemarkError(`unknown option: ${value}`);
		issueParts.push(value);
	}

	const issue = issueParts.join(" ").trim() || undefined;
	return { issue, model, outDir, timeoutSeconds, help, version };
}

export function newRunId(now = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	// Match the production Root Goal identifier so the Manager cannot infer the
	// benchmark harness from its model-visible context. The output namespace is
	// kept separately by the host and is not injected into that context.
	return `task-${stamp}-${randomBytes(2).toString("hex")}`;
}

export function resolveOutputDir(
	configured: string | undefined,
	runId: string,
	cwd = process.cwd(),
	codeflowHome = process.env.CODEFLOW_HOME ?? path.join(os.homedir(), ".codeflow"),
): string {
	if (configured !== undefined) return path.resolve(cwd, configured);
	const outputDir = path.resolve(cwd, codeflowHome, "codemark", "runs", runId);
	const canonicalFuturePath = (target: string): string => {
		const suffix: string[] = [];
		let existing = target;
		while (!fs.existsSync(existing)) {
			const parent = path.dirname(existing);
			if (parent === existing) break;
			suffix.unshift(path.basename(existing));
			existing = parent;
		}
		let canonical = existing;
		try { canonical = fs.realpathSync(existing); } catch { /* retain the resolved ancestor */ }
		return path.join(canonical, ...suffix);
	};
	const canonicalRepository = canonicalFuturePath(path.resolve(cwd));
	const canonicalOutput = canonicalFuturePath(outputDir);
	const relative = path.relative(canonicalRepository, canonicalOutput);
	if (
		relative === ""
		|| (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
	) {
		throw new CodemarkError("default output directory resolves inside the repository; use --out outside it");
	}
	return outputDir;
}

function number(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function emptyUsageTotals(): CodemarkUsageTotals {
	return {
		calls: 0,
		input: 0,
		output: 0,
		cache_read: 0,
		cache_write: 0,
		reasoning: 0,
		total_tokens: 0,
		cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 },
	};
}

function usageRecord(message: unknown, runId: string, turn: number): CodemarkUsageRecord | null {
	if (typeof message !== "object" || message === null) return null;
	const candidate = message as Record<string, unknown>;
	if (candidate.role !== "assistant" || typeof candidate.usage !== "object" || candidate.usage === null) return null;
	const provider = typeof candidate.provider === "string" ? candidate.provider : "";
	const responseModel = typeof candidate.responseModel === "string" ? candidate.responseModel : "";
	const model = responseModel || (typeof candidate.model === "string" ? candidate.model : "");
	if (!provider || !model) return null;
	const raw = candidate.usage as Record<string, unknown>;
	const rawCost = typeof raw.cost === "object" && raw.cost !== null
		? raw.cost as Record<string, unknown>
		: {};
	if (
		candidate.stopReason === "aborted"
		&& number(raw.input) === 0
		&& number(raw.output) === 0
		&& number(raw.cacheRead ?? raw.cache_read) === 0
		&& number(raw.cacheWrite ?? raw.cache_write) === 0
		&& number(raw.reasoning) === 0
		&& number(raw.totalTokens ?? raw.total_tokens) === 0
	) {
		// Pi emits a zero-usage synthetic assistant message when shutdown aborts
		// the next loop before any provider request. It is not a Manager call.
		return null;
	}
	const timestamp = number(candidate.timestamp);
	return {
		schema_version: USAGE_SCHEMA_VERSION,
		at: timestamp > 0 ? new Date(timestamp).toISOString() : nowIso(),
		run_id: runId,
		process_kind: "manager",
		turn,
		provider,
		model,
		response_model: model,
		usage: {
			input: number(raw.input),
			output: number(raw.output),
			cache_read: number(raw.cacheRead ?? raw.cache_read),
			cache_write: number(raw.cacheWrite ?? raw.cache_write),
			reasoning: number(raw.reasoning),
			total_tokens: number(raw.totalTokens ?? raw.total_tokens),
			cost: {
				input: number(rawCost.input),
				output: number(rawCost.output),
				cache_read: number(rawCost.cacheRead ?? rawCost.cache_read),
				cache_write: number(rawCost.cacheWrite ?? rawCost.cache_write),
				total: number(rawCost.total),
			},
		},
	};
}

function addUsage(target: CodemarkUsageTotals, usage: Omit<CodemarkUsageTotals, "calls">): void {
	target.calls += 1;
	target.input += usage.input;
	target.output += usage.output;
	target.cache_read += usage.cache_read;
	target.cache_write += usage.cache_write;
	target.reasoning += usage.reasoning;
	target.total_tokens += usage.total_tokens;
	target.cost.input += usage.cost.input;
	target.cost.output += usage.cost.output;
	target.cost.cache_read += usage.cost.cache_read;
	target.cost.cache_write += usage.cost.cache_write;
	target.cost.total += usage.cost.total;
}

export function buildUsageReport(runId: string, records: CodemarkUsageRecord[]): CodemarkUsageReport {
	const total = emptyUsageTotals();
	const models = new Map<string, { provider: string; model: string; usage: CodemarkUsageTotals }>();
	for (const record of records) {
		addUsage(total, record.usage);
		const key = `${record.provider}/${record.model}`;
		let model = models.get(key);
		if (!model) {
			model = { provider: record.provider, model: key, usage: emptyUsageTotals() };
			models.set(key, model);
		}
		addUsage(model.usage, record.usage);
	}
	return {
		schema_version: USAGE_SCHEMA_VERSION,
		run_id: runId,
		generated_at: nowIso(),
		records,
		models: [...models.values()]
			.map((entry) => ({ provider: entry.provider, model: entry.model, ...entry.usage }))
			.sort((left, right) => left.model.localeCompare(right.model)),
		total,
	};
}

function appendTail(current: string, chunk: string): string {
	const next = current + chunk;
	return next.length > DIAGNOSTIC_LIMIT ? next.slice(-DIAGNOSTIC_LIMIT) : next;
}

function observeLine(line: string, runId: string, observation: ManagerObservation): void {
	try {
		const event = JSON.parse(line) as Record<string, any>;
		if (event.type !== "message_end" || event.message?.role !== "assistant") return;
		// A later automatic continuation must not turn an interrupted or truncated
		// measurement into a successful natural completion.
		if (!["error", "aborted", "length"].includes(observation.stopReason ?? "")) {
			observation.stopReason = typeof event.message.stopReason === "string"
				? event.message.stopReason
				: observation.stopReason;
		}
		if (typeof event.message.errorMessage === "string" && event.message.errorMessage) {
			observation.errorMessage ??= event.message.errorMessage;
		}
		const record = usageRecord(event.message, runId, observation.usageRecords.length + 1);
		if (record) observation.usageRecords.push(record);
	} catch {
		// Pi may emit ordinary process output. It is deliberately discarded.
	}
}

async function drain(
	stream: unknown,
	onLine: (line: string) => void,
	onChunk?: (chunk: string) => void,
	signal?: AbortSignal,
): Promise<void> {
	if (!stream || typeof (stream as ReadableStream).getReader !== "function") return;
	const reader = (stream as ReadableStream<Uint8Array>).getReader();
	const cancel = (): void => { void reader.cancel().catch(() => undefined); };
	if (signal?.aborted) cancel();
	else signal?.addEventListener("abort", cancel, { once: true });
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const text = decoder.decode(value, { stream: true });
			onChunk?.(text);
			buffer += text;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) onLine(line);
		}
	} catch (error) {
		if (!signal?.aborted) throw error;
	} finally {
		signal?.removeEventListener("abort", cancel);
	}
	buffer += decoder.decode();
	if (buffer.trim()) onLine(buffer);
}

export function buildManagerInput(): string {
	return "Inspect the Task and organize the work needed to close it.";
}

function assertOutputDirAvailable(outputDir: string): void {
	try {
		fs.lstatSync(outputDir);
		throw new CodemarkError(`output directory already exists: ${outputDir}`);
	} catch (error) {
		if (error instanceof CodemarkError) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function createPrivateRunDir(repository: string): string {
	const prefix = `.codeflow-root-${randomBytes(16).toString("hex")}-`;
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.chmodSync(runDir, 0o700);
	const relative = path.relative(fs.realpathSync(repository), fs.realpathSync(runDir));
	if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
		fs.rmSync(runDir, { recursive: true, force: true });
		throw new CodemarkError("cannot create Manager staging outside the repository");
	}
	return runDir;
}

function publishRunDirectory(privateRunDir: string, outputDir: string): void {
	assertOutputDirAvailable(outputDir);
	const parent = path.dirname(outputDir);
	fs.mkdirSync(parent, { recursive: true });
	const publishDir = fs.mkdtempSync(path.join(
		parent,
		`.codeflow-publish-${randomBytes(16).toString("hex")}-`,
	));
	try {
		for (const name of ["request.json", "usage.json", "initial-organization.json"]) {
			fs.copyFileSync(path.join(privateRunDir, name), path.join(publishDir, name));
		}
		// The complete three-file bundle becomes visible in one same-directory rename.
		fs.renameSync(publishDir, outputDir);
	} catch (error) {
		fs.rmSync(publishDir, { recursive: true, force: true });
		throw error;
	}
	fs.rmSync(privateRunDir, { recursive: true, force: true });
}

function managerEnvironment(runId: string, runDir: string, requestFile: string, repository: string): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		...process.env,
		PATH: `${path.join(RUNTIME_DIR, "bin")}:${process.env.PATH ?? ""}`,
		PI_CODING_AGENT_DIR: RUNTIME_DIR,
		CODEMARK_RUN_ID: runId,
		CODEMARK_RUN_DIR: runDir,
		CODEMARK_ISSUE_FILE: requestFile,
		CODEMARK_REPOSITORY: repository,
	};
	for (const name of [
		"CODEFLOW_RUN_ID",
		"CODEFLOW_RUNS_DIR",
		"CODEFLOW_GOAL_ID",
		"CODEFLOW_EXECUTION_ID",
		"CODEFLOW_COMMITMENT_ID",
		"CODEFLOW_PARENT_COMMITMENT_ID",
		"CODEFLOW_WORK_FOCUS",
		"CODEFLOW_PROCESS_KIND",
		"CODEFLOW_AGENT_MODEL",
	]) delete env[name];
	return env;
}

function terminateProcess(child: Bun.Subprocess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		try { child.kill(signal); } catch { /* already exited */ }
	}
}

async function issueFromInput(parsed: CodemarkArguments, supplied?: string): Promise<string> {
	if (parsed.issue) return parsed.issue;
	const input = supplied ?? (process.stdin.isTTY ? "" : await new Response(Bun.stdin.stream()).text());
	const issue = input.trim();
	if (!issue) throw new CodemarkError("an issue argument or non-empty stdin is required");
	return issue;
}

function providerFailure(code: number, observation: ManagerObservation): boolean {
	return code !== 0 || observation.stopReason === "error" || Boolean(observation.errorMessage);
}

export function firstTurnEndWins(
	termination: string | null,
	turnEndedAt: string | null,
	cutoffAtMs: number | null,
): boolean {
	if (termination !== "first_turn_end" || turnEndedAt === null) return false;
	const turnEndedAtMs = Date.parse(turnEndedAt);
	// Cross-process ISO timestamps have millisecond precision. A durable turn end at
	// the same observable millisecond as the cutoff wins the defined tie.
	return Number.isFinite(turnEndedAtMs) && (cutoffAtMs === null || turnEndedAtMs <= cutoffAtMs);
}

export async function run(argv: string[], options: RunOptions = {}): Promise<number> {
	const parsed = parseArguments(argv);
	if (parsed.help) {
		console.log(usage());
		return 0;
	}
	if (parsed.version) {
		console.log(`codemark ${VERSION}`);
		return 0;
	}
	if (process.env.CODEFLOW_RUN_ID) {
		throw new CodemarkError("codemark cannot start inside a Codeflow Task");
	}

	const repository = path.resolve(options.cwd ?? process.cwd());
	const issue = await issueFromInput(parsed, options.stdin);
	const manager = resolveAgent(CONFIG_FILE, parsed.model ?? process.env.CODEFLOW_AGENT_MODEL);
	const runId = newRunId(options.now);
	const outputDir = resolveOutputDir(parsed.outDir, runId, repository);
	assertOutputDirAvailable(outputDir);
	const runDir = createPrivateRunDir(repository);
	const requestFile = path.join(runDir, "request.json");
	const relativePrompt = (prompt: string): string => path.relative(PACKAGE_ROOT, prompt);
	try {
		writeJsonAtomic(requestFile, {
			schema_version: 1,
			run_id: runId,
			created_at: nowIso(),
			issue,
			repository,
			manager: {
				provider: manager.provider,
				model: manager.model,
				thinking_level: manager.thinkingLevel ?? null,
				prompts: manager.promptPaths.map(relativePrompt),
			},
			limits: { timeout_seconds: parsed.timeoutSeconds },
		});
		createInitialOrganization(runDir, {
			runId,
			issue,
			repository,
			manager: {
				provider: manager.provider,
				model: manager.model,
				thinking_level: manager.thinkingLevel ?? null,
				prompt_paths: manager.promptPaths.map(relativePrompt),
			},
			limits: { timeout_seconds: parsed.timeoutSeconds },
		});
	} catch (error) {
		fs.rmSync(runDir, { recursive: true, force: true });
		throw error;
	}

	console.error(
		`codemark run_id=${runId} out=${outputDir} agent=${manager.provider}/${manager.model} timeout=${parsed.timeoutSeconds}s`,
	);

	const argvForManager = [
		...buildAgentArgv(
			manager,
			buildManagerInput(),
			EXTENSIONS,
			TOOL_ALLOWLIST,
		),
		"--no-session",
	];
	let child: Bun.Subprocess;
	try {
		child = Bun.spawn(argvForManager, {
			cwd: repository,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
			env: managerEnvironment(runId, runDir, requestFile, repository),
		});
	} catch (error) {
		finalizeOrganization(runDir, {
			termination: "provider_failure",
			diagnostic: "manager process could not start",
		});
		const report = buildUsageReport(runId, []);
		writeJsonAtomic(path.join(runDir, "usage.json"), report);
		attachOrganizationUsage(runDir, report.total);
		const artifact = publishInitialOrganization(runDir);
		publishRunDirectory(runDir, outputDir);
		console.error(`codemark: error: manager process could not start: ${(error as Error).message}`);
		console.log(JSON.stringify({
			run_id: runId,
			status: artifact.status,
			termination: artifact.termination,
			artifact: path.join(outputDir, "initial-organization.json"),
			metrics: artifact.metrics,
			assessment: artifact.assessment,
			usage: report.total,
		}));
		return 1;
	}

	const observation: ManagerObservation = { stderrTail: "", usageRecords: [] };
	const cutoffState: { current: Cutoff | null } = { current: null };
	let childExited = false;
	let drainingAfterExit = false;
	let escalation: ReturnType<typeof setTimeout> | undefined;
	const stop = (kind: "timeout" | "interrupted"): void => {
		if (childExited) {
			// Preserve the already-determined natural exit outcome, but do not let a
			// descendant holding the Manager's pipes survive a late host signal.
			if (drainingAfterExit) terminateProcess(child, "SIGTERM");
			return;
		}
		if (cutoffState.current !== null) return;
		const atMs = Date.now();
		cutoffState.current = { kind, atMs, at: new Date(atMs).toISOString() };
		terminateProcess(child, "SIGTERM");
		escalation ??= setTimeout(() => terminateProcess(child, "SIGKILL"), 5_000);
	};
	const onSigint = (): void => stop("interrupted");
	const onSigterm = (): void => stop("interrupted");
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);
	const timeout = setTimeout(() => stop("timeout"), parsed.timeoutSeconds * 1_000);
	const drainAbort = new AbortController();
	const drained = Promise.all([
		drain(child.stdout, (line) => observeLine(line, runId, observation), undefined, drainAbort.signal),
		drain(child.stderr, () => undefined, (chunk) => {
			observation.stderrTail = appendTail(observation.stderrTail, chunk);
		}, drainAbort.signal),
	]);
	const code = await child.exited;
	childExited = true;
	drainingAfterExit = true;
	clearTimeout(timeout);
	if (escalation) clearTimeout(escalation);
	// Keep the handlers installed while output drains and the terminal artifact
	// is published. Once the child has exited, stop() deliberately absorbs a
	// late signal instead of letting the default handler tear this commit window.
	// The direct Manager may leave a descendant holding its inherited pipes. End
	// the detached process group, then cancel any still-open readers after a
	// bounded grace so neither the wall-clock timeout nor host signals can hang.
	terminateProcess(child, "SIGTERM");
	const drainDeadline = setTimeout(() => {
		terminateProcess(child, "SIGKILL");
		drainAbort.abort();
	}, POST_EXIT_DRAIN_GRACE_MS);
	try {
		await drained;
	} finally {
		clearTimeout(drainDeadline);
		drainingAfterExit = false;
	}

	const usageReport = buildUsageReport(runId, observation.usageRecords);
	writeJsonAtomic(path.join(runDir, "usage.json"), usageReport);
	const current = readInitialOrganization(runDir);
	const cutoff = cutoffState.current;
	const firstTurnEndWon = firstTurnEndWins(
		current.termination,
		current.timestamps.completed_at,
		cutoff?.atMs ?? null,
	);
	if (!firstTurnEndWon) {
		if (cutoff?.kind === "timeout") {
			finalizeOrganization(runDir, {
				termination: "timeout",
				diagnostic: `wall-clock limit ${parsed.timeoutSeconds}s reached at ${cutoff.at}`,
				force: true,
			});
		} else if (cutoff?.kind === "interrupted") {
			finalizeOrganization(runDir, {
				termination: "interrupted",
				diagnostic: `codemark received an interrupt signal at ${cutoff.at}`,
				force: true,
			});
		} else if (observation.stopReason === "aborted") {
			finalizeOrganization(runDir, { termination: "interrupted", diagnostic: "Manager turn was aborted before its first natural turn end" });
		} else if (observation.stopReason === "length") {
			finalizeOrganization(runDir, {
				termination: "output_truncated",
				diagnostic: "Manager output reached the provider length limit before its first natural turn end",
			});
		} else if (providerFailure(code, observation)) {
			finalizeOrganization(runDir, { termination: "provider_failure", diagnostic: "Manager provider or process failed" });
		} else {
			finalizeOrganization(runDir, { termination: "manager_exit", diagnostic: "Manager exited before its first natural turn end" });
		}
	}
	attachOrganizationUsage(runDir, usageReport.total);
	const artifact = publishInitialOrganization(runDir);
	try {
		publishRunDirectory(runDir, outputDir);
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	}
	const success = artifact.status === "completed" && artifact.termination === "first_turn_end";
	if (!success) {
		const detail = (observation.errorMessage ?? observation.stderrTail).trim().slice(-DIAGNOSTIC_LIMIT);
		console.error(`codemark: error: measurement ended with ${artifact.termination}${detail ? `\n${detail}` : ""}`);
	}
	console.log(JSON.stringify({
		run_id: runId,
		status: artifact.status,
		termination: artifact.termination,
		artifact: path.join(outputDir, "initial-organization.json"),
		metrics: artifact.metrics,
		assessment: artifact.assessment,
		usage: usageReport.total,
	}));
	return success ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
	try {
		return await run(argv);
	} catch (error) {
		if (
			error instanceof CodemarkError
			|| error instanceof ConfigError
			|| error instanceof CodemarkOrganizationError
		) {
			console.error(`codemark: error: ${error.message}`);
			return 1;
		}
		throw error;
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
