/**
 * Contract tests for role resolution.
 *
 * The agent Markdown file is the single source of truth for a role's identity,
 * so these pin how frontmatter maps to a pi invocation — including the
 * defaults, because a silently wrong default is worse than a loud failure.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ALLOWED_KEYS,
	buildArgv,
	listRoles,
	parseFrontmatter,
	readFrontmatter,
	resolveRole,
	RoleError,
} from "../../runtime/lib/roles";
import { newRunId } from "../../runtime/cli/run";

let dir: string;

function writeAgent(role: string, frontmatter: string, body = "Do the thing carefully.\n"): void {
	fs.writeFileSync(path.join(dir, `${role}.md`), `---\n${frontmatter}\n---\n\n${body}`, "utf-8");
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-roles-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("frontmatter parsing", () => {
	test("reads top-level keys", () => {
		const parsed = parseFrontmatter("---\nmodel: kimi/k3\ndescription: does things\n---\nbody\n");
		expect(parsed.model).toBe("kimi/k3");
		expect(parsed.description).toBe("does things");
	});

	test("stops at the closing delimiter", () => {
		// A body line that looks like a key must not become configuration.
		const parsed = parseFrontmatter("---\nmodel: kimi/k3\n---\nmodel: not-this\n");
		expect(parsed.model).toBe("kimi/k3");
	});

	test("ignores indented lines, so nesting cannot smuggle config in", () => {
		const parsed = parseFrontmatter("---\nmodel: kimi/k3\n  nested: value\n---\n");
		expect(parsed).not.toHaveProperty("nested");
	});

	test("a value may contain a colon", () => {
		expect(parseFrontmatter("---\ndescription: does a: thing\n---\n").description).toBe(
			"does a: thing",
		);
	});

	test("text with no frontmatter yields nothing", () => {
		expect(parseFrontmatter("just a body\n")).toEqual({});
	});
});

describe("listing", () => {
	test("lists roles alphabetically", () => {
		writeAgent("planner", "model: a/b");
		writeAgent("coder", "model: a/b");
		expect(listRoles(dir)).toEqual(["coder", "planner"]);
	});

	test("ignores non-Markdown files", () => {
		writeAgent("planner", "model: a/b");
		fs.writeFileSync(path.join(dir, "notes.txt"), "hello");
		expect(listRoles(dir)).toEqual(["planner"]);
	});

	test("a missing directory yields nothing", () => {
		expect(listRoles(path.join(dir, "absent"))).toEqual([]);
	});
});

describe("resolution", () => {
	test("splits the provider from the model", () => {
		writeAgent("coder", "model: kimi/k3");
		const resolved = resolveRole(dir, "coder")!;
		expect(resolved.provider).toBe("kimi");
		expect(resolved.model).toBe("k3");
	});

	test("the agent file is the system prompt", () => {
		writeAgent("coder", "model: kimi/k3");
		expect(resolveRole(dir, "coder")!.systemPrompt).toBe(path.join(dir, "coder.md"));
	});

	test("an unknown role resolves to null, not an error", () => {
		expect(resolveRole(dir, "ghost")).toBeNull();
	});

	test("a model without a provider is rejected loudly", () => {
		// Failing here is far cheaper than failing at model-call time.
		writeAgent("coder", "model: k3");
		expect(() => resolveRole(dir, "coder")).toThrow(RoleError);
	});

	test("a missing model is rejected", () => {
		writeAgent("coder", "description: no model");
		expect(() => resolveRole(dir, "coder")).toThrow(RoleError);
	});

	test("a tool allowlist is split and trimmed", () => {
		writeAgent("verify", "model: m/m\ntools: read, bash , skill");
		expect(resolveRole(dir, "verify")!.tools).toEqual(["read", "bash", "skill"]);
	});

	test("no allowlist means no restriction", () => {
		writeAgent("planner", "model: m/m");
		expect(resolveRole(dir, "planner")!.tools).toEqual([]);
	});

	test("worker roles use Pi defaults while delegation remains explicit", () => {
		const productionDir = path.resolve(import.meta.dir, "../../runtime/agents");
		const expected = new Map([
			["architect", undefined],
			["coder", undefined],
			["planner", "read,write,bash,goal,task,task_group"],
			["supervisor", "read,write,bash"],
			["verify", undefined],
			["tester", undefined],
			["title-compressor", "read"],
			["zipper", undefined],
		]);

		for (const role of listRoles(productionDir)) {
			expect(expected.has(role)).toBeTrue();
			expect(readFrontmatter(productionDir, role)?.tools).toBe(expected.get(role));
		}
		expect(listRoles(productionDir).sort()).toEqual([...expected.keys()].sort());
		expect(fs.existsSync(path.join(productionDir, "command.md"))).toBeFalse();
		expect(fs.existsSync(path.join(productionDir, "initializer.md"))).toBeFalse();
	});

	test("delegation requires the exact string true", () => {
		writeAgent("planner", "model: m/m\ndelegates: true");
		expect(resolveRole(dir, "planner")!.delegates).toBe(true);
	});

	test("a truthy-looking value does not grant delegation", () => {
		// Delegation is the highest-privilege flag; it must be declared exactly.
		writeAgent("coder", "model: m/m\ndelegates: yes");
		expect(resolveRole(dir, "coder")!.delegates).toBe(false);
	});

	test("absent delegation defaults to false", () => {
		writeAgent("coder", "model: m/m");
		expect(resolveRole(dir, "coder")!.delegates).toBe(false);
	});

	test("readFrontmatter returns null for an unknown role", () => {
		expect(readFrontmatter(dir, "ghost")).toBeNull();
	});
});

describe("argv construction", () => {
	function resolvedCoder() {
		writeAgent("coder", "model: kimi/k3");
		return resolveRole(dir, "coder")!;
	}

	test("passes provider and model explicitly", () => {
		const argv = buildArgv(resolvedCoder(), "do it", []);
		expect(argv[argv.indexOf("--provider") + 1]).toBe("kimi");
		expect(argv[argv.indexOf("--model") + 1]).toBe("k3");
	});

	test("never auto-loads context files", () => {
		// The context extension owns injection; implicit loading would make
		// what a role knows unauditable.
		expect(buildArgv(resolvedCoder(), "do it", [])).toContain("--no-context-files");
	});

	test("loads extensions in the given order", () => {
		const argv = buildArgv(resolvedCoder(), "do it", ["/a.ts", "/b.ts"]);
		const loaded = argv.filter((_, index) => argv[index - 1] === "--extension");
		expect(loaded).toEqual(["/a.ts", "/b.ts"]);
	});

	test("omits the tools flag when unrestricted", () => {
		expect(buildArgv(resolvedCoder(), "do it", [])).not.toContain("--tools");
	});

	test("joins an allowlist into one flag", () => {
		writeAgent("verify", "model: m/m\ntools: read,bash");
		const argv = buildArgv(resolveRole(dir, "verify")!, "run", []);
		expect(argv[argv.indexOf("--tools") + 1]).toBe("read,bash");
	});

	test("the prompt is passed as a single argument", () => {
		const argv = buildArgv(resolvedCoder(), "two words", []);
		expect(argv[argv.indexOf("-p") + 1]).toBe("two words");
	});

	test("an explicit session id and directory are passed to pi", () => {
		const argv = buildArgv(resolvedCoder(), "continue work", [], {
			id: "run-1-goal-1-code",
			dir: "/tmp/codeflow-sessions",
		});
		expect(argv[argv.indexOf("--session-id") + 1]).toBe("run-1-goal-1-code");
		expect(argv[argv.indexOf("--session-dir") + 1]).toBe("/tmp/codeflow-sessions");
	});

	test("role policy fields are validated", () => {
		writeAgent("invalid-lane", "model: a/m\ngoal_lane: product");
		expect(() => resolveRole(dir, "invalid-lane")).toThrow(RoleError);
	});
});

describe("allowed keys", () => {
	test("role policy keys are explicit and validated", () => {
		// Every extra knob is behaviour not explained by the prompt.
			expect([...ALLOWED_KEYS].sort()).toEqual([
				"delegates",
				"description",
				"goal_lane",
				"model",
				"needs_project_rules",
				"tools",
			]);
	});
});

describe("run ids", () => {
	test("are prefixed and carry a timestamp", () => {
		expect(newRunId(new Date("2026-08-14T09:30:15.000Z"))).toMatch(
			/^run-20260814-093015-[0-9a-f]{4}$/,
		);
	});

	test("sort chronologically as strings", () => {
		// So listing run directories answers "which was latest" with no metadata.
		const earlier = newRunId(new Date("2026-08-14T09:00:00.000Z"));
		const later = newRunId(new Date("2026-08-14T10:00:00.000Z"));
		expect([later, earlier].sort()).toEqual([earlier, later]);
	});

	test("two ids in the same second still differ", () => {
		const now = new Date("2026-08-14T09:30:15.000Z");
		expect(newRunId(now)).not.toBe(newRunId(now));
	});
});
