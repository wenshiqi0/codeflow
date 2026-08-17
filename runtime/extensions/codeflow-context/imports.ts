/**
 * Explicit imports for role context.
 *
 * A role prompt declares its reference dependencies instead of asking the
 * model to locate runtime files. The context extension resolves that graph
 * before the first provider request, so import relationships are established
 * mechanically rather than rediscovered with shell commands.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const MAX_CONTEXT_IMPORTS = 32;
const MAX_IMPORT_DEPTH = 16;

const IMPORT_DIRECTIVE_PATTERN = /<!--\s*codeflow:import\b([\s\S]*?)-->/g;
const IMPORT_PATH_PATTERN = /\bpath\s*=\s*"([^"]*)"/;
const IMPORT_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;

export class ContextImportError extends Error {}

export interface ContextImport {
	ref: string;
	content: string;
}

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function displayPath(root: string, file: string): string {
	return path.relative(root, file).split(path.sep).join("/");
}

function directivePath(attributes: string): string {
	const match = IMPORT_PATH_PATTERN.exec(attributes);
	const ref = match?.[1] ?? "";
	if (!IMPORT_REF_PATTERN.test(ref)) {
		throw new ContextImportError(`invalid codeflow:import path: ${ref || "(missing)"}`);
	}
	return ref;
}

/** Extract import declarations in their lexical order. */
export function parseImportDirectives(text: string): string[] {
	const refs: string[] = [];
	for (const match of text.matchAll(IMPORT_DIRECTIVE_PATTERN)) {
		refs.push(directivePath(match[1] ?? ""));
	}
	return refs;
}

/** Remove import plumbing from text shown to the model. */
export function stripImportDirectives(text: string): string {
	return text.replace(/<!--\s*codeflow:import\b[\s\S]*?-->\s*/g, "");
}

function resolveImport(runtimeDir: string, ref: string): string {
	const contextRoot = path.dirname(runtimeDir);
	const referencesRoot = path.join(contextRoot, "references");
	const file = path.resolve(contextRoot, ref);
	if (!file.endsWith(".md") || !inside(referencesRoot, file)) {
		throw new ContextImportError(`context import must stay below references/: ${ref}`);
	}

	let realFile: string;
	let realRoot: string;
	try {
		realFile = fs.realpathSync(file);
		realRoot = fs.realpathSync(referencesRoot);
	} catch {
		throw new ContextImportError(`context import does not exist: ${ref}`);
	}
	if (!inside(realRoot, realFile)) {
		throw new ContextImportError(`context import escapes references/: ${ref}`);
	}
	if (!realFile.endsWith(".md")) {
		throw new ContextImportError(`context import must resolve to a Markdown file: ${ref}`);
	}
	return realFile;
}

/**
 * Load an import graph rooted in the Codeflow checkout's references directory.
 *
 * Imports are recursive and de-duplicated. Cycles and oversized graphs are
 * configuration errors: silently omitting a declared dependency would make the
 * visible context manifest misleading.
 */
export function loadContextImports(text: string, runtimeDir: string): ContextImport[] {
	const contextRoot = fs.realpathSync(path.dirname(runtimeDir));
	const byPath = new Map<string, ContextImport>();
	const ordered: ContextImport[] = [];

	function visit(ref: string, depth: number, chain: Set<string>): void {
		if (ordered.length >= MAX_CONTEXT_IMPORTS) {
			throw new ContextImportError(`context import limit exceeded: ${MAX_CONTEXT_IMPORTS}`);
		}
		const file = resolveImport(runtimeDir, ref);
		if (chain.has(file)) {
			throw new ContextImportError(`context import cycle: ${displayPath(contextRoot, file)}`);
		}
		if (byPath.has(file)) return;
		if (depth >= MAX_IMPORT_DEPTH) {
			throw new ContextImportError(`context import depth exceeded: ${MAX_IMPORT_DEPTH}`);
		}

		let content: string;
		try {
			content = fs.readFileSync(file, "utf-8");
		} catch {
			throw new ContextImportError(`context import is unreadable: ${ref}`);
		}

		const imported: ContextImport = {
			ref: displayPath(contextRoot, file),
			content: stripImportDirectives(content),
		};
		byPath.set(file, imported);
		ordered.push(imported);

		const nextChain = new Set(chain);
		nextChain.add(file);
		for (const dependency of parseImportDirectives(content)) {
			visit(dependency, depth + 1, nextChain);
		}
	}

	for (const ref of parseImportDirectives(text)) visit(ref, 0, new Set());
	return ordered;
}
