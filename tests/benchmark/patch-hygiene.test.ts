import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTmpDirs, loadBenchmarkModule, makeTmpDir } from "./helpers";

afterEach(cleanupTmpDirs);

async function bench(): Promise<any> {
	return loadBenchmarkModule();
}

function write(dir: string, relative: string, content: string | Uint8Array): void {
	const target = path.join(dir, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
}

function git(dir: string, args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", dir, ...args]);
	expect(result.exitCode).toBe(0);
}

describe("benchmark patch hygiene", () => {
	test("workspace excludes and extraction omit run artifacts and backups", async () => {
		const mod = await bench();
		const dir = path.join(makeTmpDir(), "workspace");
		mod.prepareBenchmarkWorkspace(dir);
		write(dir, "a.py", "print('fixed')\n");
		write(dir, ".codeflow/runs/x/receipt.json", "{}\n");
		write(dir, "a.py.bak", "old\n");
		write(dir, "fix.orig", "old\n");

		const status = Bun.spawnSync(["git", "-C", dir, "status", "--porcelain"]);
		expect(status.stdout.toString()).not.toContain(".codeflow");
		expect(status.stdout.toString()).not.toContain(".bak");

		const extraction = mod.extractPatchDetailed(dir);
		expect(extraction.patch).toContain("a.py");
		expect(extraction.patch).not.toContain("receipt.json");
		expect(extraction.patch).not.toContain("a.py.bak");
		expect(extraction.patch).not.toContain("fix.orig");
		expect(extraction.strippedBinaryPaths).toEqual([]);
	});

	test("pathspec excludes win over git add --f", async () => {
		const mod = await bench();
		const dir = path.join(makeTmpDir(), "workspace");
		mod.prepareBenchmarkWorkspace(dir);
		write(dir, ".codeflow/evil.txt", "must not ship\n");
		git(dir, ["add", "-f", ".codeflow/evil.txt"]);

		expect(mod.extractPatch(dir)).toBe("");
	});

	test("binary hunks are stripped while text data remains content-based", async () => {
		const mod = await bench();
		const dir = path.join(makeTmpDir(), "workspace");
		mod.prepareBenchmarkWorkspace(dir);
		write(dir, "fix.py", "print('fixed')\n");
		write(dir, "blob.bin", new Uint8Array([0x00, 0x01, 0x02, 0x00]));
		write(dir, "header.fits", "TEXT FITS HEADER WITHOUT NUL\n");

		const extraction = mod.extractPatchDetailed(dir);
		expect(extraction.strippedBinaryPaths).toEqual(["blob.bin"]);
		expect(extraction.patch).not.toContain("GIT binary patch");
		expect(extraction.patch).toContain("fix.py");
		expect(extraction.patch).toContain("header.fits");
	});

	test("empty extraction remains empty and idempotent", async () => {
		const mod = await bench();
		const dir = path.join(makeTmpDir(), "workspace");
		mod.prepareBenchmarkWorkspace(dir);
		expect(mod.extractPatchDetailed(dir)).toEqual({ patch: "", strippedBinaryPaths: [] });
		expect(mod.extractPatchDetailed(dir)).toEqual({ patch: "", strippedBinaryPaths: [] });
	});

	test("real provisioned repositories are seeded after cloning", async () => {
		const mod = await bench();
		const source = path.join(makeTmpDir(), "source");
		fs.mkdirSync(source, { recursive: true });
		Bun.spawnSync(["/usr/bin/git", "init", "-q"], { cwd: source });
		write(source, "base.py", "print('base')\n");
		git(source, ["add", "."]);
		git(source, ["-c", "user.name=test", "-c", "user.email=test.invalid", "commit", "-m", "base"]);
		const workspace = path.join(makeTmpDir(), "workspace");
		Bun.spawnSync(["/usr/bin/git", "clone", "-q", source, workspace]);

		mod.seedBenchmarkWorkspaceHygiene(workspace);
		write(workspace, ".codeflow/noise", "noise\n");
		const status = Bun.spawnSync(["git", "-C", workspace, "status", "--porcelain"]);
		expect(status.stdout.toString()).toBe("");
	});
});
