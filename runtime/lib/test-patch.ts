/**
 * Validate, apply, and re-verify test-only patches.
 *
 * The test patch is the mechanism that makes test-first real rather than
 * aspirational. `test-writer` produces it, `coder` applies it mechanically,
 * and nobody may edit it in between — so this module enforces two things:
 *
 * 1. **A test patch touches only tests.** If implementation could ride along
 *    inside the patch, "the test proves the behaviour was missing" stops being
 *    true, because the same diff could have added the behaviour.
 * 2. **The applied tests do not change afterwards.** `apply` records a lock of
 *    per-file fingerprints; `verify` re-checks them. Weakening an assertion
 *    after RED is the cheapest way to fake a GREEN, and it is exactly what a
 *    model under pressure will reach for.
 *
 * Rust gets special handling because its unit tests live inside the file they
 * test, so a `#[cfg(test)] mod` region counts as test surface while the rest
 * of the same file does not.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DIFF_RE = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const CFG_TEST_RE = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/;
const MOD_RE = /\bmod\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/;

export class PatchError extends Error {}

export interface CheckResult {
	status: "PASS";
	patch: string;
	sha256: string;
	files: string[];
	applied?: boolean;
	lock?: string;
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

function git(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync(["git", ...args], { cwd });
	const decoder = new TextDecoder();
	return {
		code: result.exitCode,
		stdout: decoder.decode(result.stdout),
		stderr: decoder.decode(result.stderr),
	};
}

/** Whether a path is test surface by convention. */
export function isTestFile(relative: string): boolean {
	const parts = relative.split("/");
	const name = parts[parts.length - 1] ?? "";
	return (
		parts.includes("tests") ||
		parts.includes("test") ||
		parts.includes("__tests__") ||
		name.startsWith("test_") ||
		[".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", "_test.rs"].some((suffix) =>
			name.endsWith(suffix),
		)
	);
}

/** Net brace depth, ignoring string literals and line comments. */
export function braceDelta(line: string): number {
	const withoutStrings = line.replace(/"(?:\\.|[^"\\])*"/g, '""');
	const code = withoutStrings.split("//")[0];
	const open = (code.match(/\{/g) ?? []).length;
	const close = (code.match(/\}/g) ?? []).length;
	return open - close;
}

/**
 * Line ranges of `#[cfg(test)] mod ... { }` regions, 1-based and inclusive.
 *
 * Co-located Rust tests mean "is this line test surface" cannot be answered
 * from the path alone.
 */
export function rustTestRanges(file: string): [number, number][] {
	let lines: string[];
	try {
		lines = fs.readFileSync(file, "utf-8").split("\n");
	} catch {
		return [];
	}
	const ranges: [number, number][] = [];
	let index = 0;
	while (index < lines.length) {
		if (!CFG_TEST_RE.test(lines[index])) {
			index++;
			continue;
		}
		const attrLine = index + 1;
		let probe = index;
		while (probe < Math.min(lines.length, index + 8) && !MOD_RE.test(lines[probe])) probe++;
		if (probe >= lines.length || !MOD_RE.test(lines[probe])) {
			index++;
			continue;
		}
		let depth = 0;
		let opened = false;
		let end = probe + 1;
		while (end <= lines.length) {
			depth += braceDelta(lines[end - 1]);
			opened = opened || lines[end - 1].includes("{");
			if (opened && depth === 0) break;
			end++;
		}
		if (opened && depth === 0) {
			ranges.push([attrLine, end]);
			index = end;
		} else {
			index++;
		}
	}
	return ranges;
}

function inRanges(line: number, ranges: [number, number][]): boolean {
	return ranges.some(([start, end]) => start <= line && line <= end);
}

/**
 * A Rust test patch must be rustfmt-clean.
 *
 * Checked in a throwaway worktree so the project tree is never touched by a
 * validation step. Skipped when rustfmt is absent: a missing formatter is not
 * evidence of a bad patch.
 */
function validateRustFormat(project: string, patchFile: string, files: string[]): void {
	const rustFiles = files.filter((file) => file.endsWith(".rs"));
	if (rustFiles.length === 0) return;
	if (Bun.which("rustfmt") === null) return;

	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-test-patch-"));
	const worktree = path.join(temporary, "repo");
	const added = git(["worktree", "add", "--detach", "--quiet", worktree, "HEAD"], project);
	if (added.code !== 0) {
		fs.rmSync(temporary, { recursive: true, force: true });
		throw new PatchError(`could not create formatting worktree: ${added.stderr.trim()}`);
	}
	try {
		const applied = git(["apply", "--recount", patchFile], worktree);
		if (applied.code !== 0) {
			throw new PatchError(
				`patch did not apply in formatting worktree: ${applied.stderr.trim()}`,
			);
		}
		const formatted = Bun.spawnSync(["rustfmt", "--edition", "2021", "--check", ...rustFiles], {
			cwd: worktree,
		});
		if (formatted.exitCode !== 0) {
			const decoder = new TextDecoder();
			const detail = (decoder.decode(formatted.stdout) + decoder.decode(formatted.stderr)).trim();
			throw new PatchError(`Rust test patch is not rustfmt-clean: ${detail}`);
		}
	} finally {
		git(["worktree", "remove", "--force", worktree], project);
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

/**
 * Validate that a patch applies cleanly and touches nothing but tests.
 *
 * Line accounting tracks each hunk's old/new position so a Rust edit can be
 * checked against that file's test ranges rather than the path alone.
 */
export function validatePatch(project: string, patchArg: string): CheckResult {
	const runRoot = path.resolve(project, ".codeflow", "runs", "test-patches");
	const resolved = path.resolve(project, patchArg);

	// Confining patches to the run directory keeps an arbitrary file on disk
	// from being applied as if test-writer had produced it.
	if (!fs.existsSync(resolved) || !resolved.startsWith(runRoot + path.sep)) {
		throw new PatchError("patch must be a file below .codeflow/runs/test-patches/");
	}

	const text = fs.readFileSync(resolved, "utf-8");
	if (
		text.includes("GIT binary patch") ||
		text.includes("rename from ") ||
		text.includes("deleted file mode ")
	) {
		throw new PatchError("binary, rename, and file deletion patches are not allowed");
	}

	const check = git(["apply", "--check", "--recount", resolved], project);
	if (check.code !== 0) {
		throw new PatchError(`git apply --check failed: ${check.stderr.trim()}`);
	}

	const files: string[] = [];
	let current: string | null = null;
	let ranges: [number, number][] = [];
	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;

	for (const line of text.split("\n")) {
		const header = DIFF_RE.exec(line);
		if (header) {
			const [, left, right] = header;
			if (left !== right) throw new PatchError("patch must not rename files");
			const parts = right.split("/");
			if (path.posix.isAbsolute(right) || parts.includes("..") || parts.length === 0) {
				throw new PatchError(`unsafe patch path: ${right}`);
			}
			current = right;
			files.push(right);
			inHunk = false;
			const target = path.join(project, right);
			ranges = right.endsWith(".rs") && fs.existsSync(target) ? rustTestRanges(target) : [];
			continue;
		}

		const hunk = HUNK_RE.exec(line);
		if (hunk) {
			if (current === null) throw new PatchError("hunk appeared before a file header");
			oldLine = Number.parseInt(hunk[1], 10);
			newLine = Number.parseInt(hunk[3], 10);
			inHunk = true;
			continue;
		}

		if (!inHunk || current === null || line.startsWith("--- ") || line.startsWith("+++ ")) {
			continue;
		}

		const fullTestFile = isTestFile(current);
		if (line.startsWith(" ")) {
			oldLine++;
			newLine++;
		} else if (line.startsWith("-")) {
			if (!fullTestFile && !(current.endsWith(".rs") && inRanges(oldLine, ranges))) {
				throw new PatchError(`non-test deletion rejected: ${current}:${oldLine}`);
			}
			oldLine++;
		} else if (line.startsWith("+")) {
			const anchor = oldLine;
			const insideRust =
				current.endsWith(".rs") &&
				(inRanges(anchor, ranges) || inRanges(Math.max(1, anchor - 1), ranges));
			if (!fullTestFile && !insideRust) {
				throw new PatchError(`non-test addition rejected: ${current}:${newLine}`);
			}
			newLine++;
		}
	}

	if (files.length === 0) throw new PatchError("patch contains no files");

	const unique = [...new Set(files)].sort();
	validateRustFormat(project, resolved, unique);

	return {
		status: "PASS",
		patch: path.relative(project, resolved),
		sha256: sha256(text),
		files: unique,
	};
}

/**
 * Fingerprint the test surface of each applied file.
 *
 * For Rust only the `#[cfg(test)]` regions are hashed, so implementing in the
 * same file is allowed while touching its tests is not.
 */
export function fileFingerprints(project: string, files: string[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (const relative of files) {
		const target = path.join(project, relative);
		if (isTestFile(relative)) {
			result[relative] = sha256(fs.readFileSync(target, "utf-8"));
		} else if (relative.endsWith(".rs")) {
			const lines = fs.readFileSync(target, "utf-8").split("\n");
			const ranges = rustTestRanges(target);
			if (ranges.length === 0) {
				throw new PatchError(`applied Rust file has no test region: ${relative}`);
			}
			result[relative] = sha256(
				ranges.map(([start, end]) => lines.slice(start - 1, end).join("\n")).join("\n"),
			);
		} else {
			throw new PatchError(`cannot fingerprint non-test file: ${relative}`);
		}
	}
	return result;
}

function lockPathFor(patchFile: string): string {
	return patchFile + ".lock.json";
}

export function applyPatch(project: string, patchArg: string): CheckResult {
	const result = validatePatch(project, patchArg);
	const resolved = path.resolve(project, patchArg);

	const applied = git(["apply", "--recount", "--whitespace=error", resolved], project);
	if (applied.code !== 0) {
		throw new PatchError(`git apply failed after validation: ${applied.stderr.trim()}`);
	}

	// The lock is what makes a later assertion change detectable.
	const lockFile = lockPathFor(resolved);
	fs.writeFileSync(
		lockFile,
		JSON.stringify(
			{
				schema_version: 1,
				patch_sha256: result.sha256,
				files: fileFingerprints(project, result.files),
			},
			null,
			2,
		) + "\n",
		"utf-8",
	);

	return { ...result, applied: true, lock: path.relative(project, lockFile) };
}

export function verifyPatch(project: string, patchArg: string): Record<string, unknown> {
	const resolved = path.resolve(project, patchArg);
	const lockFile = lockPathFor(resolved);
	if (!fs.existsSync(lockFile)) {
		throw new PatchError(`test lock does not exist: ${lockFile}`);
	}

	const lock = JSON.parse(fs.readFileSync(lockFile, "utf-8")) as {
		patch_sha256?: string;
		files?: Record<string, string>;
	};
	const patchSha = sha256(fs.readFileSync(resolved, "utf-8"));
	if (lock.patch_sha256 !== patchSha) {
		throw new PatchError("test patch checksum no longer matches its lock");
	}

	const current = fileFingerprints(project, Object.keys(lock.files ?? {}));
	const changed = Object.entries(current)
		.filter(([file, digest]) => (lock.files ?? {})[file] !== digest)
		.map(([file]) => file)
		.sort();
	if (changed.length > 0) {
		throw new PatchError(`applied requirement tests changed after lock: ${changed.join(", ")}`);
	}

	return {
		status: "PASS",
		patch: patchArg,
		patch_sha256: patchSha,
		tests_unchanged: true,
	};
}

export function main(argv: string[]): number {
	const [action, patchArg] = argv;
	if (!action || !patchArg || !["check", "apply", "verify"].includes(action)) {
		console.error("usage: test-patch <check|apply|verify> <patch>");
		return 1;
	}
	const project = process.cwd();
	try {
		const result =
			action === "verify"
				? verifyPatch(project, patchArg)
				: action === "apply"
					? applyPatch(project, patchArg)
					: { ...validatePatch(project, patchArg), applied: false };
		console.log(JSON.stringify(result, null, 2));
		return 0;
	} catch (error) {
		if (error instanceof PatchError) {
			console.error(JSON.stringify({ status: "FAIL", error: error.message }));
			return 1;
		}
		throw error;
	}
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}
