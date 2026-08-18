/** Pure host-runtime boundary checks shared with tests. */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
		path.dirname(RUNTIME_LINK_DIR),
		path.dirname(RUNTIME_REAL_DIR),
	]),
].sort((left, right) => right.length - left.length);

function realPath(target: string): string {
	try {
		return fs.realpathSync(target).split(path.sep).join("/");
	} catch {
		const parent = path.dirname(target);
		if (parent === target) return target;
		return path.join(realPath(parent), path.basename(target)).split(path.sep).join("/");
	}
}

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function runtimeAccessViolation(value: string | undefined): string | null {
	if (typeof value !== "string") return null;
	const target = realPath(path.resolve(value));
	if (HOST_ROOTS.some((root) => target === root || inside(root, target))) {
		return "Codeflow runtime is read-only during a run";
	}
	return null;
}

export function runtimeWriteViolation(value: string | undefined): string | null {
	return runtimeAccessViolation(value);
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

export function runtimeBashViolation(command: string | undefined): string | null {
	if (typeof command !== "string") return null;
	const normalized = command.trim();
	// A root-wide find can discover the host runtime without spelling its path,
	// and it can run for an unbounded amount of time. Product work has no valid
	// reason to crawl the entire host filesystem; require a scoped search root.
	const scansFilesystemRoot = /(?:^|[;&|]\s*)(?:sudo\s+|command\s+)?find(?:\s+-[^\s]+)*\s+(?:["']\/['"]|\/)(?=\s|$)/.test(
		normalized,
	);
	if (scansFilesystemRoot) {
		return "Codeflow roles must not scan the host filesystem root; use a project-scoped search path";
	}
	const offenders = [
		...HOST_ROOTS,
		"$PI_CODING_AGENT_DIR",
		"${PI_CODING_AGENT_DIR}",
		"process.env.PI_CODING_AGENT_DIR",
		"../codeflow",
	];
	if (!offenders.some((marker) => normalized.includes(marker))) return null;
	if (readOnlyRuntimeCommand(normalized)) return null;
	return "Codeflow runtime is read-only during a run";
}
