/** Pure host-runtime boundary checks shared with tests. */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

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

export function runtimeWriteViolation(value: string | undefined): string | null {
	if (typeof value !== "string") return null;
	const target = realPath(path.resolve(value));
	if (inside(RUNTIME_DIR, target)) {
		return "Codeflow runtime is read-only during a run";
	}
	return null;
}

export function runtimeBashViolation(command: string | undefined): string | null {
	if (typeof command !== "string") return null;
	const normalized = command.trim();
	const offenders = [
		RUNTIME_DIR,
		"$PI_CODING_AGENT_DIR",
		"${PI_CODING_AGENT_DIR}",
		"process.env.PI_CODING_AGENT_DIR",
		"../codeflow",
	];
	if (!offenders.some((marker) => normalized.includes(marker))) return null;

	// Read-only inspection of runtime files is safe and keeps normal environment
	// discovery working. Mutating commands and shell redirection remain blocked.
	const hasWriteShape = /[\n;&|<>`]|\$\(/.test(normalized);
	const firstWord = /^\s*(?:sudo\s+)?([A-Za-z0-9_.-]+)/.exec(normalized)?.[1] ?? "";
	const readOnlyCommands = new Set([
		"cat",
		"echo",
		"find",
		"git",
		"grep",
		"ls",
		"pwd",
		"rg",
		"test",
	]);
	if (!hasWriteShape && readOnlyCommands.has(firstWord)) return null;
	return "Codeflow runtime is read-only during a run";
}
