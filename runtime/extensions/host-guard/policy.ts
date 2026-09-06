/** Pure host-runtime boundary checks shared with tests. */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RUNS_DIR } from "../../lib/paths";

const RUNTIME_LINK_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const RUNTIME_REAL_DIR = realPath(RUNTIME_LINK_DIR);
const HOST_ROOTS = [
	...new Set([
		RUNTIME_LINK_DIR,
		RUNTIME_REAL_DIR,
	]),
].sort((left, right) => right.length - left.length);

type Environment = Record<string, string | undefined>;

/** A bounded shell lexer for common command wrappers, not a security sandbox. */
function shellSegments(command: string): string[][] {
	const segments: string[][] = [];
	let words: string[] = [];
	let word = "";
	let quote = "";
	const flushWord = () => { if (word) words.push(word); word = ""; };
	const flushSegment = () => { flushWord(); if (words.length) segments.push(words); words = []; };
	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (char === "\\" && quote !== "'") { word += command[++index] ?? ""; continue; }
		if (quote) { if (char === quote) quote = ""; else word += char; continue; }
		if (char === "'" || char === '"') { quote = char; continue; }
		if (/[;|&()\n]/.test(char)) { flushSegment(); continue; }
		if (/\s/.test(char)) { flushWord(); continue; }
		word += char;
	}
	flushSegment();
	return segments;
}

function unwrapCommand(input: string[]): string[] {
	const words = [...input];
	while (words.length) {
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) { words.shift(); continue; }
		const executable = path.basename(words[0]);
		if (["command", "exec", "sudo", "nohup", "setsid", "env", "if", "then", "do", "!"].includes(executable)) {
			words.shift();
			while (words[0]?.startsWith("-")) {
				const option = words.shift();
				if (["-u", "--unset", "--user", "-g", "--group", "-C", "--chdir"].includes(option!)) words.shift();
			}
			continue;
		}
		if (executable === "timeout") {
			words.shift();
			while (words[0]?.startsWith("-")) {
				if (["-s", "--signal", "-k", "--kill-after"].includes(words.shift()!)) words.shift();
			}
			words.shift(); // duration
			continue;
		}
		break;
	}
	return words;
}

function codeTeamCommand(command: string): string[] | null {
	const segments = shellSegments(command);
	if (segments.length !== 1 || /[\n;&|<>`]|\$\(/.test(command)) return null;
	const words = unwrapCommand(segments[0]);
	return path.basename(words[0] ?? "") === "codeteam" ? words : null;
}

function realPath(target: string): string {
	try {
		return fs.realpathSync(target).split(path.sep).join("/");
	} catch {
		const parent = path.dirname(target);
		if (parent === target) return target;
		return path.join(realPath(parent), path.basename(target)).split(path.sep).join("/");
	}
}

function covers(root: string, target: string): boolean {
	if (target === root) return true;
	const relative = path.relative(root, target);
	return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function runStateRoot(environment: Environment): string | null {
	const runId = environment.CODEFLOW_RUN_ID;
	if (!runId) return null;
	return path.resolve(environment.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, runId);
}

function canonicalRunStateRoot(environment: Environment): string | null {
	const runState = runStateRoot(environment);
	return runState === null ? null : realPath(runState);
}

function runtimeAccessViolation(value: string | undefined, environment: Environment = process.env): string | null {
	if (typeof value !== "string") return null;
	const target = realPath(path.resolve(value));
	const runtimeProtected = HOST_ROOTS.some((root) => covers(root, target));
	const runState = canonicalRunStateRoot(environment);
	const stateProtected = runState !== null && covers(runState, target);
	if (runtimeProtected || stateProtected) return "Codeflow runtime is read-only during a run";
	return null;
}

export function runtimeWriteViolation(
	value: string | undefined,
	environment: Environment = process.env,
): string | null {
	return runtimeAccessViolation(value, environment);
}

function readOnlyGitCommand(normalized: string): boolean {
	const words = normalized.split(/\s+/);
	while (words[0] === "sudo" || words[0] === "command") words.shift();
	if (words.shift() !== "git") return false;
	while (words.length > 0) {
		const word = words[0];
		if (word === "-C" || word === "--git-dir" || word === "--work-tree") {
			words.splice(0, 2);
			continue;
		}
		if (word === "--no-pager" || word.startsWith("--git-dir=") || word.startsWith("--work-tree=")) {
			words.shift();
			continue;
		}
		break;
	}
	return new Set(["diff", "grep", "log", "ls-files", "rev-parse", "show", "status"]).has(
		words[0] ?? "",
	);
}

function readOnlyRuntimeCommand(normalized: string): boolean {
	// Command composition and redirection can turn an otherwise read-only tool
	// into a mutation. Fail closed instead of trying to parse a shell program.
	if (/[\n;&|<>`]|\$\(/.test(normalized)) return false;
	const firstWord =
		/^\s*(?:(?:sudo|command)\s+)?([A-Za-z0-9_.-]+)/.exec(normalized)?.[1] ?? "";
	if (firstWord === "git") return readOnlyGitCommand(normalized);
	if (firstWord === "find") {
		return !/(?:^|\s)-(?:delete|exec|execdir|fls|fprint|fprint0|fprintf|ok|okdir)(?:\s|$)/.test(
			normalized,
		);
	}
	return new Set(["cat", "echo", "grep", "ls", "pwd", "rg", "test"]).has(firstWord);
}

export function runtimeBashViolation(
	command: string | undefined,
	environment: Environment = process.env,
): string | null {
	if (typeof command !== "string") return null;
	const normalized = command.trim();
	// A root-wide find can discover the host runtime without spelling its path,
	// and it can run for an unbounded amount of time. Product work has no valid
	// reason to crawl the entire host filesystem; require a scoped search root.
	const scansFilesystemRoot = /(?:^|[;&|]\s*)(?:sudo\s+|command\s+)?find(?:\s+-[^\s]+)*\s+(?:["']\/['"]|\/)(?=\s|$)/.test(
		normalized,
	);
	if (scansFilesystemRoot) {
		return "Codeflow agents must not scan the host filesystem root; use a project-scoped search path";
	}
	const runState = runStateRoot(environment);
	const canonicalRunState = canonicalRunStateRoot(environment);
	const offenders = [
		...HOST_ROOTS,
		"$PI_CODING_AGENT_DIR",
		"${PI_CODING_AGENT_DIR}",
		"process.env.PI_CODING_AGENT_DIR",
		"$CODEFLOW_RUNS_DIR",
		"${CODEFLOW_RUNS_DIR}",
		"process.env.CODEFLOW_RUNS_DIR",
		...(runState === null ? [] : [runState]),
		...(canonicalRunState === null ? [] : [canonicalRunState]),
	];
	if (!offenders.some((marker) => normalized.includes(marker))) return null;
	// codeteam owns its validated metadata writes; invoking its public commands
	// is different from directly editing Runtime files. Engineering helper output
	// paths remain subject to the ordinary Runtime write boundary.
	const words = codeTeamCommand(normalized);
	if (words) {
		if (["start", "goal", "spawn", "followup", "resume", "status", "inspect", "watch", "sub", "usage", "finish", "stop", "--help", "-h"].includes(words[1] ?? "")) return null;
		if (!words.slice(1).some((word) => offenders.some((marker) => word.includes(marker)))) return null;
	}
	if (readOnlyRuntimeCommand(normalized)) return null;
	return "Codeflow runtime is read-only during a run";
}
