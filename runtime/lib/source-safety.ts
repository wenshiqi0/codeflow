/**
 * Reject non-printing control bytes in changed text source files.
 *
 * Models occasionally emit a literal ESC or NUL into source — usually a stray
 * terminal colour sequence copied out of command output. The byte is invisible
 * in most editors and diffs, so it survives review and then breaks a compiler
 * or a shell far from where it was introduced. Cheaper to reject mechanically
 * than to debug later.
 *
 * Tab, newline, and carriage return are the only control bytes allowed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const TEXT_SUFFIXES = new Set([
	".c", ".cc", ".cpp", ".css", ".go", ".h", ".hpp", ".html", ".java",
	".js", ".json", ".jsx", ".md", ".py", ".rs", ".sh", ".sql", ".toml",
	".ts", ".tsx", ".txt", ".yaml", ".yml",
]);

const ALLOWED_CONTROLS = new Set([0x09, 0x0a, 0x0d]);

export interface Violation {
	path: string;
	line: number;
	column: number;
	byte: number;
}

export function isForbidden(byte: number): boolean {
	return (byte < 0x20 && !ALLOWED_CONTROLS.has(byte)) || byte === 0x7f;
}

/** Locate forbidden bytes with a line and column a human can navigate to. */
export function scan(file: string, data: Uint8Array): Violation[] {
	const violations: Violation[] = [];
	let line = 1;
	let column = 0;
	for (const byte of data) {
		if (byte === 0x0a) {
			line++;
			column = 0;
			continue;
		}
		column++;
		if (isForbidden(byte)) {
			violations.push({ path: file, line, column, byte });
		}
	}
	return violations;
}

/**
 * Paths git reports as changed, including untracked files.
 *
 * Run artifacts under `.codeflow/` are excluded: they legitimately carry
 * captured command output, control bytes included.
 */
export function changedPaths(cwd = process.cwd()): string[] {
	const result = Bun.spawnSync(
		["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
		{ cwd },
	);
	if (result.exitCode !== 0) {
		throw new Error(`git status failed: ${new TextDecoder().decode(result.stderr)}`);
	}

	const items = new TextDecoder().decode(result.stdout).split("\0");
	const paths: string[] = [];
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (!item) continue;
		const status = item.slice(0, 2);
		let raw = item.slice(3);
		// A rename or copy puts the destination in the following record.
		if (status.startsWith("R") || status.startsWith("C")) {
			if (++index >= items.length) break;
			raw = items[index];
		}
		if (!raw) continue;
		if (!raw.split(path.sep).includes(".codeflow")) paths.push(raw);
	}
	return paths;
}

export function checkPaths(candidates: string[]): { checked: number; violations: Violation[] } {
	const violations: Violation[] = [];
	let checked = 0;
	for (const candidate of [...new Set(candidates)].sort()) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(candidate);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;
		if (!TEXT_SUFFIXES.has(path.extname(candidate).toLowerCase())) continue;
		checked++;
		violations.push(...scan(candidate, fs.readFileSync(candidate)));
	}
	return { checked, violations };
}

export function main(argv: string[]): number {
	if (argv.includes("--self-test")) {
		// The check has to be trustworthy before it is used as a gate.
		const clean = scan("x", new TextEncoder().encode("plain\tline\ncarriage\rutf8:\u4e2d"));
		const dirty = scan("x", Uint8Array.from([110, 0x00, 101, 0x1b, 100, 0x7f]));
		if (clean.length !== 0 || dirty.map((entry) => entry.byte).join(",") !== "0,27,127") {
			console.error("source-safety self-test failed");
			return 1;
		}
		console.log(JSON.stringify({ status: "PASS", self_test: true }));
		return 0;
	}

	const explicit = argv.filter((token) => !token.startsWith("--"));
	const { checked, violations } = checkPaths(explicit.length > 0 ? explicit : changedPaths());

	if (violations.length > 0) {
		console.error("source safety check failed:");
		for (const violation of violations) {
			console.error(
				`- ${violation.path}:${violation.line}:${violation.column}: ` +
					`forbidden control byte 0x${violation.byte.toString(16).padStart(2, "0")}`,
			);
		}
		return 1;
	}
	console.log(JSON.stringify({ status: "PASS", checked_files: checked }));
	return 0;
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}
