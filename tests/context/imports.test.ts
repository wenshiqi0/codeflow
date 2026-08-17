import { describe, afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ContextImportError,
	loadContextImports,
	parseImportDirectives,
} from "../../runtime/extensions/codeflow-context/imports";

let root: string;

afterEach(() => {
	if (root === undefined) return;
	fs.rmSync(root, { recursive: true, force: true });
	root = undefined as unknown as string;
});

function makeRuntime(files: Record<string, string>): string {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-imports-"));
	const runtime = path.join(root, "runtime");
	const references = path.join(root, "references");
	fs.mkdirSync(runtime);
	fs.mkdirSync(references);
	for (const [name, content] of Object.entries(files)) {
		fs.writeFileSync(path.join(references, name), content, "utf8");
	}
	return runtime;
}

describe("context import directives", () => {
	test("extracts explicit paths in order", () => {
		const text = [
			"before",
			'<!-- codeflow:import path="references/a.md" -->',
			'<!-- codeflow:import path="references/b.md" -->',
			"after",
		].join("\n");
		expect(parseImportDirectives(text)).toEqual(["references/a.md", "references/b.md"]);
	});

	test("rejects malformed declarations rather than silently dropping them", () => {
		expect(() => parseImportDirectives("<!-- codeflow:import reference='references/a.md' -->")).toThrow(
			ContextImportError,
		);
	});
});

describe("context import graph", () => {
	test("follows and de-duplicates recursive imports", () => {
		const runtime = makeRuntime({
			"root.md": '<!-- codeflow:import path="references/left.md" -->\nroot\n',
			"left.md": '<!-- codeflow:import path="references/shared.md" -->\nleft\n',
			"right.md": '<!-- codeflow:import path="references/shared.md" -->\nright\n',
			"shared.md": "shared\n",
		});
		const imports = loadContextImports(
			'<!-- codeflow:import path="references/root.md" -->\n' +
				'<!-- codeflow:import path="references/right.md" -->\n',
			runtime,
		);
		expect(imports.map((imported) => imported.ref)).toEqual([
			"references/root.md",
			"references/left.md",
			"references/shared.md",
			"references/right.md",
		]);
		expect(imports.map((imported) => imported.content).join("\n")).not.toContain("codeflow:import");
	});

	test("rejects paths outside runtime references", () => {
		const runtime = makeRuntime({ "safe.md": "safe\n" });
		fs.writeFileSync(path.join(runtime, "AGENTS.md"), "outside\n", "utf8");
		const references = path.join(path.dirname(runtime), "references");
		fs.writeFileSync(path.join(references, "target.txt"), "not markdown\n", "utf8");
		fs.symlinkSync(path.join(references, "target.txt"), path.join(references, "link.md"));
		expect(() =>
			loadContextImports('<!-- codeflow:import path="references/../AGENTS.md" -->', runtime),
		).toThrow(ContextImportError);
		expect(() => loadContextImports('<!-- codeflow:import path="/etc/passwd.md" -->', runtime)).toThrow(
			ContextImportError,
		);
		expect(() => loadContextImports('<!-- codeflow:import path="references/safe.txt" -->', runtime)).toThrow(
			ContextImportError,
		);
		expect(() => loadContextImports('<!-- codeflow:import path="references/link.md" -->', runtime)).toThrow(
			ContextImportError,
		);
	});

	test("missing imports fail loudly", () => {
		const runtime = makeRuntime({});
		expect(() => loadContextImports('<!-- codeflow:import path="references/missing.md" -->', runtime)).toThrow(
			ContextImportError,
		);
	});

	test("import cycles are configuration errors", () => {
		const runtime = makeRuntime({
			"a.md": '<!-- codeflow:import path="references/b.md" -->\na\n',
			"b.md": '<!-- codeflow:import path="references/a.md" -->\nb\n',
		});
		expect(() => loadContextImports('<!-- codeflow:import path="references/a.md" -->', runtime)).toThrow(
			ContextImportError,
		);
	});
});
