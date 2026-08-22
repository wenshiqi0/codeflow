#!/usr/bin/env bun

import {
	EvidenceError,
	runCommandEvidence,
	writeCommandReceipt,
} from "../lib/command-evidence";
import { DEFAULT_RUNS_DIR, RunPaths } from "../lib/paths";
import * as fs from "node:fs";
import * as path from "node:path";

const LOG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_LOG_BOUND = 65_536;

function usage(): string {
	return (
		"usage: code-agent evidence run --id <id> [--timeout-ms <ms>] -- <command> [args...]\n" +
		"       code-agent evidence run --id <id> [--no-dedupe] [--timeout-ms <ms>] -- <command> [args...]\n" +
		"       code-agent evidence receipt --output <file>\n" +
		"       code-agent evidence log <id> [--head N] [--tail N] [--grep <pattern>]\n" +
		"\n" +
		"--timeout-ms overrides CODEFLOW_EVIDENCE_TIMEOUT_MS; 0 disables the guard.\n" +
		"A timed-out command is killed with its whole process tree and recorded\n" +
		"as exit 124, failure_class RUNNER_BLOCKED, error_class EXECUTION_TIMEOUT."
	);
}

function flagValue(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : undefined;
}

function logPaths(id: string): string[] {
	if (!LOG_ID_PATTERN.test(id)) throw new EvidenceError("invalid evidence log id");
	const runId = process.env.CODEFLOW_RUN_ID;
	if (!runId) throw new EvidenceError("CODEFLOW_RUN_ID is required");
	const paths = new RunPaths(
		process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR,
		runId,
	);
	if (!fs.existsSync(paths.evidence)) throw new EvidenceError(`evidence log not found: ${id}`);
	const matches: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const target = path.join(directory, entry.name);
			if (entry.isDirectory()) walk(target);
			else if (entry.name === `${id}.txt` || (entry.name === `${id}.json` && target.includes(`${path.sep}commands${path.sep}`))) {
				matches.push(target);
			}
		}
	};
	walk(paths.evidence);
	if (matches.length === 0) throw new EvidenceError(`evidence log not found: ${id}`);
	if (matches.length > 1) throw new EvidenceError(`evidence log id is ambiguous: ${id}`);
	return matches;
}

function commandEvidenceText(file: string): string {
	let entry: Record<string, unknown>;
	try {
		entry = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		throw new EvidenceError(`evidence record is unreadable: ${path.basename(file)}`);
	}
	const runsRoot = path.dirname(path.dirname(path.dirname(path.dirname(file))));
	const readRef = (key: string): string => {
		const relative = entry[key];
		if (typeof relative !== "string") return "";
		try {
			return fs.readFileSync(path.resolve(runsRoot, relative), "utf8");
		} catch {
			return "";
		}
	};
	return [
		`command: ${String(entry.command ?? "")}`,
		`exit_code: ${String(entry.exit_code ?? "")}`,
		"--- stdout ---",
		readRef("stdout_ref"),
		"--- stderr ---",
		readRef("stderr_ref"),
	].join("\n");
}

function boundedHeadTail(text: string, head: number, tail: number): string {
	if (text.length <= head + tail) return text;
	return `${text.slice(0, head)}\n...[omitted ${text.length - head - tail} bytes]...\n${text.slice(text.length - tail)}`;
}

function grepContext(text: string, pattern: string): string {
	let matcher: RegExp;
	try {
		matcher = new RegExp(pattern, "u");
	} catch {
		matcher = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u");
	}
	const lines = text.split("\n");
	const selected = new Set<number>();
	for (let index = 0; index < lines.length; index++) {
		if (!matcher.test(lines[index])) continue;
		for (let context = Math.max(0, index - 3); context <= Math.min(lines.length - 1, index + 3); context++) {
			selected.add(context);
		}
	}
	if (selected.size === 0) return "";
	return [...selected].sort((left, right) => left - right).map((index) => lines[index]).join("\n");
}

const RUN_FLAGS = new Set(["--id", "--timeout-ms"]);
const RUN_BOOLEAN_FLAGS = new Set(["--no-dedupe"]);

/** Parse strict flag/value pairs before the `--` separator. */
function parseRunFlags(options: string[]): { id?: string; timeoutMs?: string; noDedupe?: boolean } {
	const parsed: { id?: string; timeoutMs?: string; noDedupe?: boolean } = {};
	for (let index = 0; index < options.length; index++) {
		const flag = options[index];
		if (RUN_BOOLEAN_FLAGS.has(flag)) {
			parsed.noDedupe = true;
			continue;
		}
		if (!RUN_FLAGS.has(flag) || index + 1 >= options.length) throw new EvidenceError(usage());
		const value = options[++index];
		if (flag === "--id") parsed.id = value;
		else parsed.timeoutMs = value;
	}
	return parsed;
}

export async function main(argv: string[]): Promise<number> {
	try {
		const [command, ...rest] = argv;
		if (command === "run") {
			const separator = rest.indexOf("--");
			const options = separator >= 0 ? rest.slice(0, separator) : rest;
			const { id, timeoutMs, noDedupe } = parseRunFlags(options);
			if (!id || separator < 0) {
				throw new EvidenceError(usage());
			}
			return await runCommandEvidence(id, rest.slice(separator + 1), { timeoutMs, noDedupe });
		}
		if (command === "receipt") {
			const output = flagValue(rest, "--output");
			if (!output || rest.length !== 2 || rest[0] !== "--output") {
				throw new EvidenceError(usage());
			}
			console.log(JSON.stringify(writeCommandReceipt(output)));
			return 0;
		}
		if (command === "log") {
			const [id, ...flags] = rest;
			if (!id || flags.length % 2 !== 0) throw new EvidenceError(usage());
			let head = 2_048;
			let tail = 2_048;
			let grep: string | undefined;
			for (let index = 0; index < flags.length; index += 2) {
				const flag = flags[index];
				const value = flags[index + 1];
				if (value === undefined) throw new EvidenceError(usage());
				if (flag === "--grep") grep = value;
				else if (flag === "--head" || flag === "--tail") {
					if (!/^\d+$/.test(value) || Number(value) > MAX_LOG_BOUND) {
						throw new EvidenceError(`${flag} must be an integer from 0 through ${MAX_LOG_BOUND}`);
					}
					if (flag === "--head") head = Number(value);
					else tail = Number(value);
				} else throw new EvidenceError(usage());
			}
			const file = logPaths(id)[0];
			const text = file.endsWith(".json") ? commandEvidenceText(file) : fs.readFileSync(file, "utf8");
			const output =
				grep !== undefined
					? boundedHeadTail(grepContext(text, grep), MAX_LOG_BOUND, MAX_LOG_BOUND)
					: boundedHeadTail(text, head, tail);
			process.stdout.write(output.endsWith("\n") || output === "" ? output : `${output}\n`);
			return 0;
		}
		throw new EvidenceError(usage());
	} catch (error) {
		if (error instanceof EvidenceError) {
			console.error(`code-agent evidence: error: ${error.message}`);
			return 1;
		}
		throw error;
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
