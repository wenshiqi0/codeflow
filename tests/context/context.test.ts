import { describe, expect, test } from "bun:test";
import { buildContext, escapeXml, resolveLevel, sha256 } from "../../runtime/extensions/codeflow-context/context";

const base = {
	projectRules: "project rules body",
	sharedRules: "shared rules body",
	facts: "",
	factsCursor: 0,
};

describe("resolveLevel", () => {
	test("defaults to full when a registry entry is absent", () => {
		expect(resolveLevel(null)).toBe("full");
	});

	test("defaults to full when the field is absent", () => {
		expect(resolveLevel({ model: "kimi/k3" })).toBe("full");
	});

	test("false means no rule injection", () => {
		expect(resolveLevel({ needs_project_rules: false })).toBe("none");
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

describe("buildContext imports", () => {
	test("declared documents are visible and auditable", () => {
		const { xml, sources } = buildContext({
			...base,
			level: "none",
			imports: [{ ref: "references/capabilities/planning.md", content: "# Planner\n\nCoordinate outcomes." }],
		});
		expect(xml).toContain("<context_imports>");
		expect(xml).toContain('ref="references/capabilities/planning.md"');
		expect(xml).toContain("Coordinate outcomes.");
		expect(sources).toEqual([
			{
				kind: "context_import",
				ref: "references/capabilities/planning.md",
				hash: sha256("# Planner\n\nCoordinate outcomes."),
			},
		]);
	});
});

describe("buildContext continuation", () => {
	test("unchanged static sources are manifest-only; only new facts become a delta", () => {
		const first = buildContext({
			...base,
			level: "shared",
			facts: "f1: first — value [tester]",
			factsCursor: 1,
		});
		const second = buildContext({
			...base,
			level: "shared",
			facts: "f2: second — value [coder]",
			factsCursor: 2,
			previous: {
				role: "coder",
				level: "shared",
				sources: first.sources,
				factsCursor: 1,
			},
		});

		expect(second.mode).toBe("delta");
		expect(second.xml).not.toContain("<shared_rules>");
		expect(second.xml).toContain('kind="shared_rules"');
		expect(second.xml).toContain('action="unchanged"');
		expect(second.xml).toContain("<shared_facts_delta>");
		expect(second.xml).toContain("f2: second — value [coder]");
		expect(second.xml).not.toContain("f1: first — value [tester]");
	});

	test("a changed static source is fully replaced with its previous hash", () => {
		const first = buildContext({ ...base, level: "shared" });
		const second = buildContext({
			...base,
			level: "shared",
			sharedRules: "new shared rules body",
			previous: {
				role: "coder",
				level: "shared",
				sources: first.sources,
				factsCursor: 0,
			},
		});

		expect(second.mode).toBe("delta");
		expect(second.xml).toContain(`previous_hash="${first.sources[0].hash}"`);
		expect(second.xml).toContain('action="replace"');
		expect(second.xml.match(/<shared_rules>/g)).toHaveLength(1);
		expect(second.xml).toContain("new shared rules body");
		expect(second.xml).not.toContain("project rules body");
	});

	test("a continuation with no new facts still emits a small visible manifest", () => {
		const first = buildContext({ ...base, level: "shared", factsCursor: 2 });
		const second = buildContext({
			...base,
			level: "shared",
			factsCursor: 2,
			previous: {
				role: "coder",
				level: "shared",
				sources: first.sources,
				factsCursor: 2,
			},
		});

		expect(second.mode).toBe("delta");
		expect(second.xml).toContain("No new shared facts were recorded");
		expect(second.xml).not.toContain("<shared_rules>");
		expect(second.xml).not.toContain("<shared_facts_delta");
	});

	test("a changed import set falls back to a full context block", () => {
		const first = buildContext({
			...base,
			level: "none",
			imports: [{ ref: "references/one.md", content: "one" }],
			factsCursor: 0,
		});
		const second = buildContext({
			...base,
			level: "none",
			imports: [{ ref: "references/two.md", content: "two" }],
			factsCursor: 0,
			previous: {
				role: "coder",
				level: "none",
				sources: first.sources,
				factsCursor: 0,
			},
		});

		expect(second.mode).toBe("full");
		expect(second.xml).toContain('ref="references/two.md"');
		expect(second.xml).toContain("two");
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
		expect(xml.startsWith('<codeflow_context version="1" mode="full">')).toBe(true);
		expect(xml.endsWith("</codeflow_context>")).toBe(true);
	});

	test("the model-visible block is deterministic and has no generation timestamp", () => {
		const first = buildContext({ ...base, level: "full", facts: "f1: a — b" });
		const second = buildContext({ ...base, level: "full", facts: "f1: a — b" });
		expect(first.xml).toBe(second.xml);
		expect(first.xml).not.toContain("generated_at");
	});

	test("a role with nothing injected still yields a valid manifest", () => {
		const { xml, sources } = buildContext({ ...base, level: "none", facts: "" });
		expect(sources).toEqual([]);
		expect(xml).toContain("<context_manifest");
		expect(xml).toContain("</codeflow_context>");
	});
});
