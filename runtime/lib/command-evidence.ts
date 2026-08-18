/**
 * Shell-free command execution and receipt aggregation for verify handoffs.
 *
 * A model-written pipeline can accidentally report the status of `tail` or
 * `tee` instead of the command under test. This module executes the supplied
 * argv directly, streams both output channels to complete log files, and
 * records the child's real exit code in a validator-compatible receipt entry.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_RUNS_DIR, RunPaths, writeJsonAtomic } from "./paths";

const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class EvidenceError extends Error {}

export interface CommandEvidenceEntry {
	id: string;
	status: "PASS" | "FAIL";
	command: string;
	command_argv: string[];
	exit_code: number;
	duration_ms: number;
	stdout_ref: string;
	stderr_ref: string;
	recorded_at: string;
	failure_class?: "RUNNER_BLOCKED";
}

function currentPaths(): { paths: RunPaths; handoffId: string } {
	const runId = process.env.CODEFLOW_RUN_ID;
	const handoffId = process.env.CODEFLOW_HANDOFF_ID;
	if (!runId) throw new EvidenceError("CODEFLOW_RUN_ID is required");
	if (!handoffId) throw new EvidenceError("CODEFLOW_HANDOFF_ID is required");
	const runsDir = path.resolve(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR);
	return { paths: new RunPaths(runsDir, runId), handoffId };
}

function commandDir(paths: RunPaths, handoffId: string): string {
	return path.join(paths.evidence, handoffId, "commands");
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function renderCommand(argv: string[]): string {
	return argv.map(shellQuote).join(" ");
}

function closeStream(stream: fs.WriteStream): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.once("error", reject);
		stream.end(resolve);
	});
}

export async function runCommandEvidence(id: string, argv: string[]): Promise<number> {
	if (!EVIDENCE_ID_PATTERN.test(id)) {
		throw new EvidenceError(
			"evidence id must be 1-64 filename-safe characters starting with a letter or digit",
		);
	}
	if (argv.length === 0) throw new EvidenceError("evidence run requires a command after --");

	const { paths, handoffId } = currentPaths();
	const directory = commandDir(paths, handoffId);
	fs.mkdirSync(directory, { recursive: true });
	const recordPath = path.join(directory, `${id}.json`);
	const stdoutPath = path.join(directory, `${id}.stdout.log`);
	const stderrPath = path.join(directory, `${id}.stderr.log`);
	if ([recordPath, stdoutPath, stderrPath].some((target) => fs.existsSync(target))) {
		throw new EvidenceError(`evidence id already exists for this handoff: ${id}`);
	}
	let claim: number;
	try {
		claim = fs.openSync(recordPath, "wx");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new EvidenceError(`evidence id already exists for this handoff: ${id}`);
		}
		throw error;
	}
	fs.closeSync(claim);

	const stdoutLog = fs.createWriteStream(stdoutPath, { flags: "wx" });
	const stderrLog = fs.createWriteStream(stderrPath, { flags: "wx" });
	const startedAt = Date.now();
	let spawnFailed = false;

	const child = spawn(argv[0], argv.slice(1), {
		cwd: process.cwd(),
		env: process.env,
		shell: false,
		stdio: ["inherit", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk: Buffer) => {
		stdoutLog.write(chunk);
		process.stdout.write(chunk);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderrLog.write(chunk);
		process.stderr.write(chunk);
	});
	child.on("error", (error) => {
		spawnFailed = true;
		const message = `command failed to start: ${error.message}\n`;
		stderrLog.write(message);
		process.stderr.write(message);
	});

	const exitCode = await new Promise<number>((resolve) => {
		child.once("close", (code) => resolve(spawnFailed ? 127 : (code ?? 1)));
	});
	await Promise.all([closeStream(stdoutLog), closeStream(stderrLog)]);

	const relative = (target: string) => path.relative(paths.runsRoot, target);
	const entry: CommandEvidenceEntry = {
		id,
		status: exitCode === 0 ? "PASS" : "FAIL",
		command: renderCommand(argv),
		command_argv: argv,
		exit_code: exitCode,
		duration_ms: Date.now() - startedAt,
		stdout_ref: relative(stdoutPath),
		stderr_ref: relative(stderrPath),
		recorded_at: new Date().toISOString(),
		...(spawnFailed ? { failure_class: "RUNNER_BLOCKED" as const } : {}),
	};
	writeJsonAtomic(recordPath, entry);
	console.error(`code-agent evidence: recorded ${id} at ${recordPath}`);
	return exitCode;
}

function loadEntries(paths: RunPaths, handoffId: string): CommandEvidenceEntry[] {
	const directory = commandDir(paths, handoffId);
	if (!fs.existsSync(directory)) {
		throw new EvidenceError("no command evidence exists for this handoff");
	}
	const entries = fs
		.readdirSync(directory)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => {
			try {
				return JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) as unknown;
			} catch {
				throw new EvidenceError(`command evidence entry is unreadable: ${name}`);
			}
		});
	if (entries.length === 0) throw new EvidenceError("no command evidence exists for this handoff");
	for (const [index, entry] of entries.entries()) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			!("status" in entry) ||
			!("command" in entry) ||
			!("exit_code" in entry) ||
			!(["PASS", "FAIL"] as unknown[]).includes(entry.status) ||
			typeof entry.command !== "string" ||
			typeof entry.exit_code !== "number" ||
			!Number.isInteger(entry.exit_code)
		) {
			throw new EvidenceError(`command evidence entry ${index} is malformed`);
		}
	}
	return entries as CommandEvidenceEntry[];
}

export function writeCommandReceipt(output: string): { output: string; status: "PASS" | "FAIL"; count: number } {
	const { paths, handoffId } = currentPaths();
	const entries = loadEntries(paths, handoffId);
	const status = entries.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL";
	const target = path.resolve(output);
	writeJsonAtomic(target, { status, receipts: entries });
	return { output: target, status, count: entries.length };
}
