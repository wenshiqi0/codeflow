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
		return "Codeflow runtime is not product-run context";
	}
	return null;
}

export function runtimeWriteViolation(value: string | undefined): string | null {
	return runtimeAccessViolation(value);
}

export function runtimeReadViolation(value: string | undefined): string | null {
	return runtimeAccessViolation(value);
}

export function runtimeBashViolation(command: string | undefined): string | null {
	if (typeof command !== "string") return null;
	const normalized = command.trim();
	const offenders = [
		...HOST_ROOTS,
		"$PI_CODING_AGENT_DIR",
		"${PI_CODING_AGENT_DIR}",
		"process.env.PI_CODING_AGENT_DIR",
		"../codeflow",
	];
	if (!offenders.some((marker) => normalized.includes(marker))) return null;
	return "Codeflow runtime is not product-run context";
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactRuntimeReferences(value: string): string {
	return value
		.replace(/^PI_CODING_AGENT_DIR=.*$/gm, "PI_CODING_AGENT_DIR=[redacted]")
		.replace(
			new RegExp(HOST_ROOTS.map(escapeRegExp).join("|"), "g"),
			"[Codeflow runtime redacted]",
		);
}
