import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dir, "..", "..");
const CODEMARK_BIN = path.join(REPO, "runtime", "bin", "codemark");
const ORGANIZATION_FILES = [
	path.join(REPO, "codemark", "lib", "organization.ts"),
	path.join(REPO, "codemark", "extensions", "organization", "index.ts"),
];

describe("Codemark source boundary", () => {
	test("ships an executable standalone command", () => {
		expect(fs.existsSync(CODEMARK_BIN)).toBe(true);
		expect(fs.statSync(CODEMARK_BIN).mode & 0o111).not.toBe(0);
	});

	test("planning organization never imports or invokes the Worker launcher", () => {
		for (const file of ORGANIZATION_FILES) {
			const source = fs.readFileSync(file, "utf8");
			expect(source).not.toContain("worker-launcher");
			expect(source).not.toMatch(/\b(?:delegateWorker|spawnWorker|waitForWorker)\b/);
		}
	});

	test("Codemark does not write canonical Codeflow Commitment or Receipt state", () => {
		const source = ORGANIZATION_FILES.map((file) => fs.readFileSync(file, "utf8")).join("\n");
		expect(source).not.toMatch(/\b(?:claimCommitment|submitReceipt|createTask|RunPaths)\b/);
		expect(source).not.toContain(".codeflow/runs");
	});
});
