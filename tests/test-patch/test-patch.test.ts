/**
 * Contract tests for the test-patch gate.
 *
 * This gate is what stops "write a failing test first" from degrading into
 * "write the test and the fix together", and what makes a weakened assertion
 * after RED detectable rather than invisible.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyPatch,
	braceDelta,
	fileFingerprints,
	isTestFile,
	PatchError,
	rustTestRanges,
	validatePatch,
	verifyPatch,
} from "../../runtime/lib/test-patch";

let dir: string;
let cwd: string;
const PATCH_DIR = ".codeflow/runs/test-patches";

function git(...args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], { cwd: dir });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
	}
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-patch-"));
	cwd = process.cwd();
	process.chdir(dir);
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	fs.mkdirSync("src");
	fs.mkdirSync("tests");
	fs.writeFileSync("src/index.ts", "export const x = 1;\n");
	fs.writeFileSync("tests/existing.test.ts", "test('a', () => {});\n");
	git("add", "-A");
	git("commit", "-qm", "init");
	fs.mkdirSync(PATCH_DIR, { recursive: true });
});

afterEach(() => {
	process.chdir(cwd);
	fs.rmSync(dir, { recursive: true, force: true });
});

/** Build a patch that appends lines to an existing file. */
function appendPatch(file: string, added: string[], contextLine: string): string {
	const body = [
		`diff --git a/${file} b/${file}`,
		`--- a/${file}`,
		`+++ b/${file}`,
		`@@ -1,1 +1,${1 + added.length} @@`,
		` ${contextLine}`,
		...added.map((line) => `+${line}`),
		"",
	].join("\n");
	const target = path.join(PATCH_DIR, "tests.patch");
	fs.writeFileSync(target, body, "utf-8");
	return target;
}

describe("test file recognition", () => {
	test("a tests/ directory is test surface", () => {
		expect(isTestFile("tests/a.ts")).toBe(true);
	});

	test("__tests__ is test surface", () => {
		expect(isTestFile("src/__tests__/a.ts")).toBe(true);
	});

	test("a .test.ts suffix is test surface", () => {
		expect(isTestFile("src/a.test.ts")).toBe(true);
	});

	test("a .spec.tsx suffix is test surface", () => {
		expect(isTestFile("src/a.spec.tsx")).toBe(true);
	});

	test("a test_ prefix is test surface", () => {
		expect(isTestFile("pkg/test_thing.py")).toBe(true);
	});

	test("ordinary source is not test surface", () => {
		expect(isTestFile("src/index.ts")).toBe(false);
	});
});

describe("brace accounting", () => {
	test("counts a net opening", () => {
		expect(braceDelta("mod tests {")).toBe(1);
	});

	test("counts a net closing", () => {
		expect(braceDelta("}")).toBe(-1);
	});

	test("ignores braces inside string literals", () => {
		expect(braceDelta('let s = "{{{";')).toBe(0);
	});

	test("ignores braces in a line comment", () => {
		expect(braceDelta("// {")).toBe(0);
	});
});

describe("rust test regions", () => {
	test("locates a cfg(test) module", () => {
		fs.writeFileSync(
			"src/lib.rs",
			["pub fn add() {}", "", "#[cfg(test)]", "mod tests {", "    fn t() {}", "}", ""].join("\n"),
		);
		expect(rustTestRanges("src/lib.rs")).toEqual([[3, 6]]);
	});

	test("a file with no test module has no ranges", () => {
		fs.writeFileSync("src/lib.rs", "pub fn add() {}\n");
		expect(rustTestRanges("src/lib.rs")).toEqual([]);
	});

	test("a missing file yields no ranges rather than throwing", () => {
		expect(rustTestRanges("src/absent.rs")).toEqual([]);
	});
});

describe("patch location", () => {
	test("a patch outside the run directory is rejected", () => {
		// Otherwise any file on disk could be applied as if test-writer made it.
		fs.writeFileSync("stray.patch", "diff --git a/tests/a.ts b/tests/a.ts\n");
		expect(() => validatePatch(dir, "stray.patch")).toThrow(PatchError);
	});

	test("a missing patch is rejected", () => {
		expect(() => validatePatch(dir, `${PATCH_DIR}/absent.patch`)).toThrow(PatchError);
	});
});

describe("patch content limits", () => {
	test("a binary patch is rejected", () => {
		const target = path.join(PATCH_DIR, "tests.patch");
		fs.writeFileSync(target, "GIT binary patch\n");
		expect(() => validatePatch(dir, target)).toThrow(PatchError);
	});

	test("a rename is rejected", () => {
		const target = path.join(PATCH_DIR, "tests.patch");
		fs.writeFileSync(target, "rename from tests/a.ts\n");
		expect(() => validatePatch(dir, target)).toThrow(PatchError);
	});

	test("a file deletion is rejected", () => {
		const target = path.join(PATCH_DIR, "tests.patch");
		fs.writeFileSync(target, "deleted file mode 100644\n");
		expect(() => validatePatch(dir, target)).toThrow(PatchError);
	});

	test("an empty patch is rejected", () => {
		const target = path.join(PATCH_DIR, "tests.patch");
		fs.writeFileSync(target, "\n");
		expect(() => validatePatch(dir, target)).toThrow(PatchError);
	});

	test("a patch that does not apply is rejected", () => {
		const target = appendPatch("tests/existing.test.ts", ["new"], "wrong context line");
		expect(() => validatePatch(dir, target)).toThrow(PatchError);
	});
});

describe("test-only enforcement", () => {
	test("appending to a test file is accepted", () => {
		const target = appendPatch(
			"tests/existing.test.ts",
			["test('b', () => {});"],
			"test('a', () => {});",
		);
		expect(validatePatch(dir, target).files).toEqual(["tests/existing.test.ts"]);
	});

	test("appending to product code is rejected", () => {
		// This is the rule that keeps a RED proof meaningful.
		const target = appendPatch("src/index.ts", ["export const y = 2;"], "export const x = 1;");
		expect(() => validatePatch(dir, target)).toThrow(PatchError);
	});

	test("deleting from product code is rejected", () => {
		const body = [
			"diff --git a/src/index.ts b/src/index.ts",
			"--- a/src/index.ts",
			"+++ b/src/index.ts",
			"@@ -1,1 +0,0 @@",
			"-export const x = 1;",
			"",
		].join("\n");
		const target = path.join(PATCH_DIR, "tests.patch");
		fs.writeFileSync(target, body, "utf-8");
		expect(() => validatePatch(dir, target)).toThrow(PatchError);
	});

	test("a checksum is reported for the lock", () => {
		const target = appendPatch(
			"tests/existing.test.ts",
			["test('b', () => {});"],
			"test('a', () => {});",
		);
		expect(validatePatch(dir, target).sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test("check does not modify the working tree", () => {
		const before = fs.readFileSync("tests/existing.test.ts", "utf-8");
		const target = appendPatch(
			"tests/existing.test.ts",
			["test('b', () => {});"],
			"test('a', () => {});",
		);
		validatePatch(dir, target);
		expect(fs.readFileSync("tests/existing.test.ts", "utf-8")).toBe(before);
	});
});

describe("apply and lock", () => {
	function applyValid() {
		const target = appendPatch(
			"tests/existing.test.ts",
			["test('b', () => {});"],
			"test('a', () => {});",
		);
		return { target, result: applyPatch(dir, target) };
	}

	test("applying changes the working tree", () => {
		const { result } = applyValid();
		expect(result.applied).toBe(true);
		expect(fs.readFileSync("tests/existing.test.ts", "utf-8")).toContain("test('b'");
	});

	test("applying writes a lock", () => {
		const { result } = applyValid();
		expect(fs.existsSync(path.join(dir, result.lock as string))).toBe(true);
	});

	test("verify passes immediately after apply", () => {
		const { target } = applyValid();
		expect(verifyPatch(dir, target).status).toBe("PASS");
	});

	test("verify fails when an applied test is edited", () => {
		// Weakening an assertion after RED is the cheapest way to fake GREEN.
		const { target } = applyValid();
		fs.writeFileSync("tests/existing.test.ts", "test('a', () => {});\n", "utf-8");
		expect(() => verifyPatch(dir, target)).toThrow(PatchError);
	});

	test("verify fails when the patch itself is rewritten", () => {
		const { target } = applyValid();
		fs.appendFileSync(path.join(dir, target), "\n# tampered\n");
		expect(() => verifyPatch(dir, target)).toThrow(PatchError);
	});

	test("verify without a lock is rejected", () => {
		const target = appendPatch(
			"tests/existing.test.ts",
			["test('b', () => {});"],
			"test('a', () => {});",
		);
		expect(() => verifyPatch(dir, target)).toThrow(PatchError);
	});
});

describe("fingerprints", () => {
	test("a test file is hashed whole", () => {
		expect(fileFingerprints(dir, ["tests/existing.test.ts"])["tests/existing.test.ts"]).toMatch(
			/^[0-9a-f]{64}$/,
		);
	});

	test("a non-test, non-Rust file cannot be fingerprinted", () => {
		expect(() => fileFingerprints(dir, ["src/index.ts"])).toThrow(PatchError);
	});

	test("a Rust file is hashed by its test regions only", () => {
		// So implementing in the same file stays allowed while editing its
		// tests does not.
		fs.writeFileSync(
			"src/lib.rs",
			["pub fn add() {}", "#[cfg(test)]", "mod tests {", "    fn t() {}", "}", ""].join("\n"),
		);
		const first = fileFingerprints(dir, ["src/lib.rs"])["src/lib.rs"];
		fs.writeFileSync(
			"src/lib.rs",
			[
				"pub fn add() -> u8 { 1 }",
				"#[cfg(test)]",
				"mod tests {",
				"    fn t() {}",
				"}",
				"",
			].join("\n"),
		);
		expect(fileFingerprints(dir, ["src/lib.rs"])["src/lib.rs"]).toBe(first);
	});

	test("a Rust file without a test region is rejected", () => {
		fs.writeFileSync("src/lib.rs", "pub fn add() {}\n");
		expect(() => fileFingerprints(dir, ["src/lib.rs"])).toThrow(PatchError);
	});
});
