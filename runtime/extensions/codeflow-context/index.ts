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
import { fileURLToPath } from "node:url";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildContext,
	resolveLevel,
	type ContextLevel,
	type ContextSource,
	type PreviousContext,
} from "./context";
import { loadContextImports, stripImportDirectives } from "./imports";
import { type FactRecord, ledgerPath, readFactRecords, renderFactRecords } from "../../lib/facts";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";
import { readRoleDefinition } from "../../lib/roles";

const CONTEXT_CUSTOM_TYPE = "codeflow:context";
const COMPACT_INTERCEPTED_TYPE = "codeflow:compact_intercepted";
const COMPACT_VIOLATION_TYPE = "codeflow:compact_violation";

const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROLES_FILE = path.join(RUNTIME_DIR, "roles.json");

const levelCache = new Map<string, ContextLevel>();

interface ContextFactsMetadata {
	fromCursor: number;
	toCursor: number;
}

interface ContextDetails {
	role: string;
	level: ContextLevel;
	mode: "full" | "delta" | "fallback";
	sources: ContextSource[];
	facts: ContextFactsMetadata;
	generatedAt: string;
	fallbackReason?: string;
}

interface SessionEntryLike {
	type?: string;
	customType?: string;
	details?: unknown;
}

interface SessionManagerLike {
	buildContextEntries?: () => SessionEntryLike[];
}

interface FactState {
	records: FactRecord[];
	cursor: number;
	sequenceValid: boolean;
}

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
	let level: ContextLevel = "full";
	try {
		level = resolveLevel(readRoleDefinition(ROLES_FILE, role));
	} catch {
		// No readable registry entry: fall back to full rather than guess.
	}
	levelCache.set(role, level);
	return level;
}

function readFactState(runId: string | undefined, runsDir: string): FactState {
	if (!runId) return { records: [], cursor: 0, sequenceValid: true };
	try {
		const records = readFactRecords(ledgerPath(new RunPaths(runsDir, runId).runDir));
		const sequenceValid = records.every((record, index) => record.id === `f${index + 1}`);
		return { records, cursor: sequenceValid ? records.length : 0, sequenceValid };
	} catch {
		// Missing facts cost redundant searching; a failed turn costs the run.
		return { records: [], cursor: 0, sequenceValid: true };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function validSource(value: unknown): value is ContextSource {
	if (!isRecord(value)) return false;
	return (
		typeof value.kind === "string" &&
		value.kind !== "" &&
		typeof value.ref === "string" &&
		value.ref !== "" &&
		typeof value.hash === "string" &&
		value.hash !== ""
	);
}

function sourceIdentity(source: ContextSource): string {
	return `${source.kind}\n${source.ref}`;
}

/**
 * Resolve the previous active context message. Invalid mechanical metadata is
 * a full-injection fallback, not a compatibility conversion.
 */
function resolvePreviousContext(
	sessionManager: SessionManagerLike | undefined,
	role: string,
	level: ContextLevel,
): { previous?: PreviousContext; reason?: string } {
	if (!sessionManager?.buildContextEntries) {
		return { reason: "session_manager_unavailable" };
	}

	let entries: SessionEntryLike[];
	try {
		entries = sessionManager.buildContextEntries();
	} catch {
		return { reason: "active_context_unavailable" };
	}

	const entry = [...entries].reverse().find((candidate) => {
		return candidate.type === "custom_message" && candidate.customType === CONTEXT_CUSTOM_TYPE;
	});
	if (!entry) return {};

	const details = entry.details;
	if (!isRecord(details)) return { reason: "previous_details_invalid" };
	if (details.role !== role || details.level !== level) {
		return { reason: "previous_role_or_level_mismatch" };
	}
	if (!Array.isArray(details.sources) || !details.sources.every(validSource)) {
		return { reason: "previous_sources_invalid" };
	}
	const staticSources = (details.sources as ContextSource[]).filter(
		(source) => source.kind !== "shared_facts",
	);
	const identities = new Set(staticSources.map(sourceIdentity));
	if (identities.size !== staticSources.length) {
		return { reason: "previous_sources_invalid" };
	}

	const facts = details.facts;
	if (
		!isRecord(facts) ||
		typeof facts.toCursor !== "number" ||
		!Number.isSafeInteger(facts.toCursor) ||
		facts.toCursor < 0
	) {
		return { reason: "previous_facts_cursor_invalid" };
	}

	return {
		previous: {
			role,
			level,
			sources: details.sources as ContextSource[],
			factsCursor: facts.toCursor,
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const cwd = event.systemPromptOptions?.cwd || process.cwd();
		const role = process.env.CODEFLOW_AGENT_ROLE;
		const level = roleLevel(role);
		const runsDir = process.env.CODEFLOW_RUNS_DIR || ".codeflow/runs/code";
		const imports = loadContextImports(event.systemPrompt, RUNTIME_DIR);

		const generatedAt = new Date().toISOString();
		const facts = readFactState(process.env.CODEFLOW_RUN_ID, runsDir);
		let fallbackReason: string | undefined;
		let previous: PreviousContext | undefined;

		if (!facts.sequenceValid) {
			fallbackReason = "fact_sequence_invalid";
		} else {
			const resolved = resolvePreviousContext(ctx?.sessionManager, role ?? "unknown", level);
			previous = resolved.previous;
			fallbackReason = resolved.reason;
			if (previous && previous.factsCursor > facts.cursor) {
				previous = undefined;
				fallbackReason = "facts_cursor_ahead_of_ledger";
			}
			if (process.env.CODEFLOW_CONTEXT_DELTA === "off") {
				previous = undefined;
				fallbackReason = "context_delta_disabled";
			}
		}

		const fromCursor = previous?.factsCursor ?? 0;
		const visibleRecords = previous ? facts.records.slice(fromCursor) : facts.records;
		const block = buildContext({
			level,
			projectRules: level === "full" ? readIfPresent(path.join(cwd, "AGENTS.md")) : "",
			sharedRules: level === "none" ? "" : readIfPresent(path.join(RUNTIME_DIR, "AGENTS.md")),
			imports,
			facts: renderFactRecords(visibleRecords),
			factsCursor: facts.cursor,
			previous,
		});

		const usedFallback = previous !== undefined && block.mode === "full";
		const effectiveFallbackReason =
			fallbackReason ?? (usedFallback ? "static_source_set_changed" : undefined);
		const details: ContextDetails = {
			role: role ?? "unknown",
			level,
			mode: effectiveFallbackReason !== undefined ? "fallback" : block.mode,
			sources: block.sources,
			facts: { fromCursor, toCursor: facts.cursor },
			generatedAt,
			...(effectiveFallbackReason !== undefined ? { fallbackReason: effectiveFallbackReason } : {}),
		};

		return {
			message: {
				customType: CONTEXT_CUSTOM_TYPE,
				content: block.xml,
				display: true,
				details,
			},
			systemPrompt: stripImportDirectives(event.systemPrompt),
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
