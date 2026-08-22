import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dir, "../..");

function read(relative: string): string {
	return fs.readFileSync(path.join(REPO, relative), "utf8");
}

describe("universal worker prompt", () => {
	test("the prompt is factual and organization is tool-conditional", () => {
		const worker = read("references/capabilities/worker.md");
		expect(worker).toContain("Methods for software work include");
		expect(worker).toContain("direct implementation");
		expect(worker).toContain("test-driven development");
		expect(worker).toContain("Delegation tools, when present in your toolset");
		expect(worker).toContain("Use of these\ntools is optional.");
	});

	test("model-visible worker static text contains no position or preference vocabulary", () => {
		const files = [
			"references/capabilities/worker.md",
			"runtime/AGENTS.md",
			...fs
				.readdirSync(path.join(REPO, "references/work-methods"))
				.filter((file) => file.endsWith(".md"))
				.map((file) => path.join("references/work-methods", file)),
		];
		for (const file of files) {
			const text = read(file);
			expect(text).not.toMatch(/depth/i);
			expect(text).not.toMatch(/\b(?:should|prefer|encourage|recommended|best)\b/i);
		}
		const taskExtension = fs.readFileSync(
			path.join(REPO, "runtime/extensions/codeflow-task/index.ts"),
			"utf8",
		);
		const descriptions = [...taskExtension.matchAll(/description:\s*\n?\s*"([^"]+)"/g)]
			.map((match) => match[1])
			.join("\n");
		expect(descriptions).not.toMatch(/depth/i);
		expect(descriptions).not.toMatch(/\b(?:should|prefer|encourage|recommended|best)\b/i);
	});

	test("mechanical evidence discipline is shared by every worker", () => {
		const agents = read("runtime/AGENTS.md");
		expect(agents).toContain("code-agent evidence run --id <id>");
		expect(agents).toContain("A nonzero child exit is `FAIL`");
		expect(agents).toContain("Do not weaken an assertion merely to make a test pass.");
		expect(agents).toContain("execution timeout");
		expect(agents).toContain("second call is rejected");
		expect(agents).toContain("root receipt");
		expect(agents).toContain("closure artifact");
	});

	test("archived tool logs are retrievable only through the bounded CLI channel", () => {
		const agents = read("runtime/AGENTS.md");
		expect(agents).not.toContain("below `.codeflow/runs/`");
		expect(agents).toContain("code-agent evidence log");
		expect(agents).toContain("body, receipt, and state are authoritative");
	});

	test("all generated evidence prompts point outside the target repository", () => {
		const agents = read("runtime/AGENTS.md");
		expect(agents).toContain("$CODEFLOW_EVIDENCE_DIR");
		expect(agents).toContain("not the target repository");
	});
});
