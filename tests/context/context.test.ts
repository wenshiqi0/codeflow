import { describe, expect, test } from "bun:test";
import { buildContext, escapeXml, resolveLevel, sha256 } from "../../runtime/extensions/codeflow-context/context";

const base = {
	projectRules: "project rules body",
	sharedRules: "shared rules body",
	facts: "",
	generatedAt: "2026-01-01T00:00:00.000Z",
};

describe("resolveLevel", () => {
	test("defaults to full when frontmatter is absent", () => {
		expect(resolveLevel(null)).toBe("full");
	});

	test("defaults to full when the field is absent", () => {
		expect(resolveLevel({ model: "kimi/k3" })).toBe("full");
	});

	test("false means no rule injection", () => {
		expect(resolveLevel({ needs_project_rules: false })).toBe("none");
	});

	test('the string "false" is treated as false, since frontmatter is untyped', () => {
		expect(resolveLevel({ needs_project_rules: "false" })).toBe("none");
	});

	test("shared means only the shared contract", () => {
		expect(resolveLevel({ needs_project_rules: "shared" })).toBe("shared");
	});

	test("an unrecognized value falls back to full rather than silently withholding rules", () => {
		expect(resolveLevel({ needs_project_rules: "maybe" })).toBe("full");
	});
});

describe("buildContext rule levels", () => {
	test("full injects both rule layers", () => {
		const { xml } = buildContext({ ...base, level: "full" });
		expect(xml).toContain("<project_rules>");
		expect(xml).toContain("<shared_rules>");
	});

	test("shared omits the project layer entirely", () => {
		const { xml } = buildContext({ ...base, level: "shared" });
		expect(xml).not.toContain("<project_rules>");
		expect(xml).toContain("<shared_rules>");
	});

	test("none omits both layers", () => {
		const { xml } = buildContext({ ...base, level: "none" });
		expect(xml).not.toContain("<project_rules>");
		expect(xml).not.toContain("<shared_rules>");
	});

	test("the manifest lists only what was actually injected", () => {
		const { sources } = buildContext({ ...base, level: "shared" });
		expect(sources.map((source) => source.kind)).toEqual(["shared_rules"]);
	});

	test("every source carries a content hash so injection is auditable", () => {
		const { sources } = buildContext({ ...base, level: "full" });
		for (const source of sources) {
			expect(source.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
		}
	});

	test("the hash reflects the injected content", () => {
		const { sources } = buildContext({ ...base, level: "shared" });
		expect(sources[0].hash).toBe(sha256("shared rules body"));
	});
});

describe("buildContext shared facts", () => {
	test("an empty ledger produces no facts section", () => {
		const { xml } = buildContext({ ...base, level: "full", facts: "" });
		expect(xml).not.toContain("<shared_facts>");
	});

	test("whitespace-only facts are treated as empty", () => {
		const { xml } = buildContext({ ...base, level: "full", facts: "   \n  " });
		expect(xml).not.toContain("<shared_facts>");
	});

	test("facts are injected when present", () => {
		const { xml } = buildContext({ ...base, level: "full", facts: "f1: router — src/router.ts:42" });
		expect(xml).toContain("<shared_facts>");
		expect(xml).toContain("src/router.ts:42");
	});

	test("facts reach even roles that get no rules, since search cost is the point", () => {
		const { xml } = buildContext({ ...base, level: "none", facts: "f1: router — src/router.ts" });
		expect(xml).toContain("<shared_facts>");
	});

	test("facts appear in the manifest as their own source", () => {
		const { sources } = buildContext({ ...base, level: "none", facts: "f1: a — b" });
		expect(sources.map((source) => source.kind)).toEqual(["shared_facts"]);
	});

	test("the injected text tells the role how to correct a stale fact", () => {
		const { xml } = buildContext({ ...base, level: "none", facts: "f1: a — b" });
		expect(xml).toContain("superseding fact");
	});
});

describe("XML safety", () => {
	test("angle brackets in rules cannot break out of the block", () => {
		const { xml } = buildContext({
			...base,
			level: "shared",
			sharedRules: "</shared_rules><injected>",
		});
		expect(xml).not.toContain("<injected>");
		expect(xml.match(/<\/shared_rules>/g)).toHaveLength(1);
	});

	test("ampersands are escaped", () => {
		expect(escapeXml("a & b")).toBe("a &amp; b");
	});

	test("escaping order does not double-escape", () => {
		expect(escapeXml("<a>")).toBe("&lt;a&gt;");
	});
});

describe("block structure", () => {
	test("the block is a single well-formed root element", () => {
		const { xml } = buildContext({ ...base, level: "full", facts: "f1: a — b" });
		expect(xml.startsWith('<codeflow_context version="1">')).toBe(true);
		expect(xml.endsWith("</codeflow_context>")).toBe(true);
	});

	test("the generation timestamp is recorded", () => {
		const { xml } = buildContext({ ...base, level: "none" });
		expect(xml).toContain('generated_at="2026-01-01T00:00:00.000Z"');
	});

	test("a role with nothing injected still yields a valid manifest", () => {
		const { xml, sources } = buildContext({ ...base, level: "none", facts: "" });
		expect(sources).toEqual([]);
		expect(xml).toContain("<context_manifest");
		expect(xml).toContain("</codeflow_context>");
	});
});
