/**
 * Contract tests for the run-scoped shared fact ledger.
 *
 * The ledger exists to stop every isolated role from rediscovering what an
 * earlier role already confirmed. Its value depends entirely on being
 * trustworthy, so these tests pin the mechanical guarantees: only the CLI
 * writes it, a claim must carry a verifiable locator, and a correction is an
 * appended supersede rather than an edit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendFacts,
	FactError,
	LEDGER_NAME,
	ledgerPath,
	materialize,
	MAX_CLAIM_CHARS,
	MAX_FACTS_PER_HANDOFF,
	render,
	type FactRecord,
} from "../../runtime/lib/facts";

let dir: string;
let ledger: string;
let cwd: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-facts-"));
	ledger = path.join(dir, LEDGER_NAME);
	cwd = process.cwd();
	// Path locators are repository-relative, so verification runs against cwd.
	process.chdir(dir);
	fs.mkdirSync("src");
	fs.writeFileSync("src/router.ts", "route()\n");
	fs.writeFileSync("src/config.ts", "loadConfig()\n");
});

afterEach(() => {
	process.chdir(cwd);
	fs.rmSync(dir, { recursive: true, force: true });
});

function append(entries: unknown, role = "planner", handoffId = "h-1"): FactRecord[] {
	return appendFacts(ledger, entries, role, handoffId);
}

function lines(): string[] {
	return fs.readFileSync(ledger, "utf-8").trim().split("\n");
}

describe("writing", () => {
	test("assigns sequential ids and returns them", () => {
		const written = append([
			{ claim: "route registration entry", path: "src/router.ts", line: 42 },
			{ claim: "config loader", path: "src/config.ts", symbol: "loadConfig" },
		]);
		expect(written.map((entry) => entry.id)).toEqual(["f1", "f2"]);
	});

	test("ids keep increasing across separate handoffs", () => {
		append([{ claim: "first", path: "src/router.ts" }], "planner", "h-1");
		const second = append([{ claim: "second", path: "src/config.ts" }], "coder", "h-2");
		expect(second.map((entry) => entry.id)).toEqual(["f2"]);
	});

	test("every record carries its author and handoff", () => {
		append([{ claim: "route entry", path: "src/router.ts" }], "coder", "h-9");
		const record = JSON.parse(lines()[0]);
		expect(record.role).toBe("coder");
		expect(record.handoff_id).toBe("h-9");
		expect(record.kind).toBe("fact");
	});

	test("the ledger is append-only", () => {
		append([{ claim: "first", path: "src/router.ts" }]);
		append([{ claim: "second", path: "src/config.ts" }], "coder", "h-2");
		expect(lines()).toHaveLength(2);
	});

	test("an empty batch writes nothing", () => {
		expect(append([])).toEqual([]);
		expect(fs.existsSync(ledger)).toBe(false);
	});

	test("a missing facts field is not an error", () => {
		expect(append(undefined)).toEqual([]);
		expect(fs.existsSync(ledger)).toBe(false);
	});
});

describe("claim validation", () => {
	test("claim is required", () => {
		expect(() => append([{ path: "src/router.ts" }])).toThrow(FactError);
	});

	test("a blank claim is rejected", () => {
		expect(() => append([{ claim: "   ", path: "src/router.ts" }])).toThrow(FactError);
	});

	test("a locator is required", () => {
		// A claim with nowhere to check it is an opinion, not a fact.
		expect(() => append([{ claim: "the code is clean" }])).toThrow(FactError);
	});

	test("value alone is a valid locator", () => {
		expect(append([{ claim: "test framework", value: "vitest" }])).toHaveLength(1);
	});

	test("symbol alone is a valid locator", () => {
		expect(append([{ claim: "entry symbol", symbol: "main" }])).toHaveLength(1);
	});

	test("unknown fields are rejected", () => {
		expect(() => append([{ claim: "x", value: "y", confidence: "high" }])).toThrow(FactError);
	});

	test("an entry must be an object", () => {
		expect(() => append(["route registration is in src/router.ts"])).toThrow(FactError);
	});

	test("facts must be an array", () => {
		expect(() => append({ claim: "x", value: "y" })).toThrow(FactError);
	});

	test("a reason without supersedes is rejected", () => {
		expect(() => append([{ claim: "x", value: "y", reason: "because" }])).toThrow(FactError);
	});
});

describe("path verification", () => {
	test("a nonexistent path is rejected", () => {
		// The CLI can check this mechanically, so it must.
		expect(() => append([{ claim: "router", path: "src/nope.ts" }])).toThrow(FactError);
	});

	test("an absolute path is rejected", () => {
		expect(() => append([{ claim: "router", path: path.join(dir, "src", "router.ts") }])).toThrow(
			FactError,
		);
	});

	test("a path escaping the repository is rejected", () => {
		expect(() => append([{ claim: "outside", path: "../elsewhere.ts" }])).toThrow(FactError);
	});

	test("line must be a positive integer", () => {
		expect(() => append([{ claim: "router", path: "src/router.ts", line: 0 }])).toThrow(FactError);
	});

	test("line must not be fractional", () => {
		expect(() => append([{ claim: "router", path: "src/router.ts", line: 1.5 }])).toThrow(
			FactError,
		);
	});
});

describe("supersede", () => {
	test("requires a known target", () => {
		expect(() => append([{ supersedes: "f7", claim: "moved", path: "src/config.ts" }])).toThrow(
			FactError,
		);
	});

	test("hides the original from the view", () => {
		append([{ claim: "route entry", path: "src/router.ts", line: 42 }]);
		append(
			[{ supersedes: "f1", claim: "route entry", path: "src/config.ts", reason: "split" }],
			"coder",
			"h-2",
		);
		const view = materialize(ledger);
		expect(view).toHaveLength(1);
		expect(view[0].id).toBe("f2");
		expect(view[0].path).toBe("src/config.ts");
	});

	test("is recorded as its own kind", () => {
		append([{ claim: "route entry", path: "src/router.ts" }]);
		append([{ supersedes: "f1", claim: "moved", path: "src/config.ts" }], "coder", "h-2");
		expect(lines().map((line) => JSON.parse(line).kind)).toEqual(["fact", "supersede"]);
	});

	test("superseding twice keeps only the newest", () => {
		append([{ claim: "v1", path: "src/router.ts" }]);
		append([{ supersedes: "f1", claim: "v2", path: "src/config.ts" }], "planner", "h-2");
		append([{ supersedes: "f2", claim: "v3", path: "src/router.ts" }], "planner", "h-3");
		expect(materialize(ledger).map((entry) => entry.id)).toEqual(["f3"]);
	});

	test("a correction never rewrites history", () => {
		append([{ claim: "v1", path: "src/router.ts" }]);
		const before = fs.readFileSync(ledger, "utf-8");
		append([{ supersedes: "f1", claim: "v2", path: "src/config.ts" }], "planner", "h-2");
		expect(fs.readFileSync(ledger, "utf-8").startsWith(before)).toBe(true);
	});

	test("a batch may correct a fact it recorded earlier in the same batch", () => {
		const written = append([
			{ claim: "v1", path: "src/router.ts" },
			{ supersedes: "f1", claim: "v2", path: "src/config.ts" },
		]);
		expect(written.map((entry) => entry.kind)).toEqual(["fact", "supersede"]);
		expect(materialize(ledger).map((entry) => entry.id)).toEqual(["f2"]);
	});
});

describe("noise control", () => {
	test("a handoff cannot dump unlimited facts", () => {
		const entries = Array.from({ length: MAX_FACTS_PER_HANDOFF + 1 }, (_, index) => ({
			claim: `claim ${index}`,
			value: String(index),
		}));
		expect(() => append(entries)).toThrow(FactError);
	});

	test("claim length is capped", () => {
		expect(() => append([{ claim: "x".repeat(MAX_CLAIM_CHARS + 1), value: "y" }])).toThrow(
			FactError,
		);
	});

	test("a rejected batch writes nothing", () => {
		// Validation happens before any append, so a bad entry cannot leave
		// half a batch behind.
		expect(() =>
			append([
				{ claim: "good", path: "src/router.ts" },
				{ claim: "bad", path: "src/nope.ts" },
			]),
		).toThrow(FactError);
		expect(fs.existsSync(ledger)).toBe(false);
	});
});

describe("reading", () => {
	test("materializing a missing ledger is empty, not an error", () => {
		expect(materialize(path.join(dir, "absent.jsonl"))).toEqual([]);
	});

	test("materialize preserves insertion order", () => {
		append([
			{ claim: "a", value: "1" },
			{ claim: "b", value: "2" },
		]);
		expect(materialize(ledger).map((entry) => entry.claim)).toEqual(["a", "b"]);
	});

	test("corrupt lines are skipped rather than crashing", () => {
		// A damaged ledger must degrade to fewer facts, never break the run.
		append([{ claim: "good", value: "1" }]);
		fs.appendFileSync(ledger, "{not json\n");
		expect(materialize(ledger).map((entry) => entry.claim)).toEqual(["good"]);
	});

	test("render is empty when there are no facts", () => {
		expect(render(path.join(dir, "absent.jsonl"))).toBe("");
	});

	test("render lists id, claim, and locator", () => {
		append([{ claim: "route entry", path: "src/router.ts", line: 42 }]);
		const rendered = render(ledger);
		expect(rendered).toContain("f1");
		expect(rendered).toContain("route entry");
		expect(rendered).toContain("src/router.ts:42");
	});

	test("render names the author so a reader can judge the fact", () => {
		append([{ claim: "route entry", value: "x" }], "test-writer");
		expect(render(ledger)).toContain("test-writer");
	});

	test("render omits a line number when there is none", () => {
		append([{ claim: "module", path: "src/router.ts" }]);
		expect(render(ledger)).toContain("src/router.ts [planner]");
	});
});

describe("ledgerPath", () => {
	test("places the ledger inside the run directory", () => {
		expect(ledgerPath("/runs/run-1")).toBe(path.join("/runs/run-1", LEDGER_NAME));
	});
});
