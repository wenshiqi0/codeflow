/**
 * codeflow-context extension.
 *
 * Pi runs with --no-context-files, so this extension owns everything a role
 * knows before it reads a single file: its rule layers and the run's shared
 * fact ledger.
 *
 * The ledger is the reason this extension exists. Role isolation means a
 * fresh process per handoff, which is what keeps a RED proof honest — but it
 * also means each role rediscovers the repository from scratch. Facts that an
 * earlier role confirmed and recorded in its receipt are injected here, so
 * coder does not re-derive what planner already established.
 *
 * Injection is always a visible message. Nothing steers a role that a human
 * reading the transcript cannot see.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { buildContext, resolveLevel, type ContextLevel } from "./context";

const CONTEXT_CUSTOM_TYPE = "codeflow:context";
const COMPACT_INTERCEPTED_TYPE = "codeflow:compact_intercepted";
const COMPACT_VIOLATION_TYPE = "codeflow:compact_violation";

const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENTS_DIR = path.join(RUNTIME_DIR, "agents");
const FACTS_SCRIPT = path.join(RUNTIME_DIR, "skills", "write-handoff", "scripts", "facts_cli.py");

const levelCache = new Map<string, ContextLevel>();

function readIfPresent(file: string): string {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return "";
	}
}

function roleLevel(role: string | undefined): ContextLevel {
	if (!role) return "full";
	const cached = levelCache.get(role);
	if (cached !== undefined) return cached;
	const agentFile = path.join(AGENTS_DIR, `${role}.md`);
	let level: ContextLevel = "full";
	try {
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(
			fs.readFileSync(agentFile, "utf-8"),
		);
		level = resolveLevel(frontmatter);
	} catch {
		// No readable agent file: fall back to full rather than guess.
	}
	levelCache.set(role, level);
	return level;
}

/**
 * Render the run's fact ledger.
 *
 * Delegated to the Python CLI that owns the ledger format, so there is one
 * implementation of supersede resolution rather than a TypeScript copy that
 * can drift. A failure here yields no facts: missing facts cost redundant
 * searching, while wrong facts cost correctness.
 */
function renderFacts(runId: string | undefined, runsDir: string): string {
	if (!runId) return "";
	try {
		return execFileSync("python3", [FACTS_SCRIPT, "render", "--run-id", runId, "--runs-dir", runsDir], {
			encoding: "utf-8",
			timeout: 5000,
		}).trim();
	} catch {
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		const cwd = event.systemPromptOptions?.cwd || process.cwd();
		const role = process.env.CODEFLOW_AGENT_ROLE;
		const level = roleLevel(role);
		const runsDir = process.env.CODEFLOW_RUNS_DIR || ".codeflow/runs/code";

		const { xml, sources } = buildContext({
			level,
			projectRules: level === "full" ? readIfPresent(path.join(cwd, "AGENTS.md")) : "",
			sharedRules: level === "none" ? "" : readIfPresent(path.join(RUNTIME_DIR, "AGENTS.md")),
			facts: renderFacts(process.env.CODEFLOW_RUN_ID, runsDir),
			generatedAt: new Date().toISOString(),
		});

		return {
			message: {
				customType: CONTEXT_CUSTOM_TYPE,
				content: xml,
				display: true,
				details: { role: role ?? "unknown", level, sources },
			},
		};
	});

	// Compaction is never acceptable: a silently summarized handoff produces
	// confident claims about work whose evidence is gone. A role that runs out
	// of context must fail loudly so the planner can split the work instead.
	pi.on("session_before_compact", (event) => {
		pi.appendEntry(COMPACT_INTERCEPTED_TYPE, {
			reason: event.reason,
			willRetry: event.willRetry,
			cancelled: true,
		});
		return { cancel: true };
	});

	// Compaction after cancellation means the runtime broke its contract.
	pi.on("session_compact", (event) => {
		pi.appendEntry(COMPACT_VIOLATION_TYPE, {
			reason: event.reason,
			fromExtension: event.fromExtension,
			message: "invariant violation: compaction ran despite session_before_compact cancel",
		});
	});
}
