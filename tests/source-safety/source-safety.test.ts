import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { changedPaths, checkPaths, isForbidden, main, scan } from "../../runtime/lib/source-safety";

let dir: string;
let cwd: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-safety-"));
	cwd = process.cwd();
	process.chdir(dir);
});

afterEach(() => {
	process.chdir(cwd);
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("byte classification", () => {
	test("tab, newline, and carriage return are allowed", () => {
		for (const byte of [0x09, 0x0a, 0x0d]) expect(isForbidden(byte)).toBe(false);
	});

	test("NUL, ESC, and DEL are forbidden", () => {
		for (const byte of [0x00, 0x1b, 0x7f]) expect(isForbidden(byte)).toBe(true);
	});

	test("printable ASCII is allowed", () => {
		expect(isForbidden(0x41)).toBe(false);
	});

	test("high bytes are allowed so UTF-8 survives", () => {
		expect(isForbidden(0xe4)).toBe(false);
	});
});

describe("scanning", () => {
	test("clean text yields no violations", () => {
		expect(scan("x", new TextEncoder().encode("plain\tline\ncarriage\rutf8:\u4e2d"))).toEqual([]);
	});

	test("reports the offending byte", () => {
		const found = scan("x", Uint8Array.from([110, 0x00, 101, 0x1b, 100, 0x7f]));
		expect(found.map((entry) => entry.byte)).toEqual([0, 27, 127]);
	});

	test("tracks line numbers across newlines", () => {
		const found = scan("x", new TextEncoder().encode("ok\nbad\u001b\n"));
		expect(found[0].line).toBe(2);
	});

	test("tracks the column within a line", () => {
		const found = scan("x", new TextEncoder().encode("ab\u001b"));
		expect(found[0].column).toBe(3);
	});
});

describe("file selection", () => {
	test("checks known text suffixes", () => {
		fs.writeFileSync("a.ts", "const x = 1;\n");
		expect(checkPaths(["a.ts"]).checked).toBe(1);
	});

	test("skips unknown suffixes", () => {
		// A binary asset legitimately contains control bytes.
		fs.writeFileSync("a.png", Uint8Array.from([0x00, 0x1b]));
		expect(checkPaths(["a.png"]).checked).toBe(0);
	});

	test("suffix matching is case-insensitive", () => {
		fs.writeFileSync("a.TS", "const x = 1;\n");
		expect(checkPaths(["a.TS"]).checked).toBe(1);
	});

	test("a missing path is skipped rather than fatal", () => {
		expect(checkPaths(["absent.ts"]).checked).toBe(0);
	});

	test("a directory is skipped", () => {
		fs.mkdirSync("sub");
		expect(checkPaths(["sub"]).checked).toBe(0);
	});

	test("duplicates are checked once", () => {
		fs.writeFileSync("a.ts", "ok\n");
		expect(checkPaths(["a.ts", "a.ts"]).checked).toBe(1);
	});

	test("a violation is reported with its path", () => {
		fs.writeFileSync("bad.ts", "const x = '\u001b';\n");
		expect(checkPaths(["bad.ts"]).violations[0].path).toBe("bad.ts");
	});
});

describe("git integration", () => {
	function git(...args: string[]): void {
		const result = Bun.spawnSync(["git", ...args], { cwd: dir });
		if (result.exitCode !== 0) {
			throw new Error(new TextDecoder().decode(result.stderr));
		}
	}

	test("reports untracked files", () => {
		git("init", "-q");
		fs.writeFileSync("a.ts", "ok\n");
		expect(changedPaths(dir)).toContain("a.ts");
	});

	test("excludes run artifacts", () => {
		// Captured command output legitimately contains control bytes.
		git("init", "-q");
		fs.mkdirSync(".codeflow/runs", { recursive: true });
		fs.writeFileSync(".codeflow/runs/log.txt", "\u001b[31mred\n");
		expect(changedPaths(dir).some((entry) => entry.includes(".codeflow"))).toBe(false);
	});
});

describe("cli", () => {
	test("self-test passes", () => {
		expect(main(["--self-test"])).toBe(0);
	});

	test("clean files exit zero", () => {
		fs.writeFileSync("a.ts", "const x = 1;\n");
		expect(main(["a.ts"])).toBe(0);
	});

	test("a forbidden byte exits non-zero", () => {
		fs.writeFileSync("bad.ts", "const x = '\u0000';\n");
		expect(main(["bad.ts"])).toBe(1);
	});
});
