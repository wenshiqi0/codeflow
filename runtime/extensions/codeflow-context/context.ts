/**
 * Context assembly for codeflow roles.
 *
 * Pi is launched with --no-context-files, so nothing is loaded implicitly.
 * This module builds the visible XML block injected at the start of every
 * turn. Three things go in it:
 *
 *   - the rule layers a role is entitled to (see ContextLevel), and
 *   - the run's shared fact ledger, so an isolated role starts from what
 *     earlier roles already confirmed instead of grepping for it again.
 *
 * Injection is a visible message, never hidden system-prompt concatenation:
 * whatever steers the model is auditable by a human reading the transcript.
 */

import { createHash } from "node:crypto";
import type { ContextImport } from "./imports";

/**
 * How much of the rule stack a role sees.
 *   "full"   — project AGENTS.md plus the shared codeflow contract
 *   "shared" — only the shared contract (implementers)
 *   "none"   — neither (pure executors: they follow the handoff, not policy)
 */
export type ContextLevel = "full" | "shared" | "none";

export interface ContextSource {
	kind: string;
	ref: string;
	hash: string;
	action?: "initial" | "unchanged" | "replace" | "delta";
	previousHash?: string;
}

export interface PreviousContext {
	role: string;
	level: ContextLevel;
	sources: ContextSource[];
	factsCursor: number;
}

export interface ContextInput {
	level: ContextLevel;
	projectRules: string;
	sharedRules: string;
	imports?: ContextImport[];
	facts: string;
	factsCursor: number;
	previous?: PreviousContext;
}

export interface ContextBlock {
	xml: string;
	sources: ContextSource[];
	mode: "full" | "delta";
	factsCursor: number;
}

export function sha256(input: string): string {
	return "sha256:" + createHash("sha256").update(input).digest("hex");
}

/** Escape text embedded in XML content. */
export function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sourceKey(source: ContextSource): string {
	return `${source.kind}\n${source.ref}`;
}

function manifestAttributes(source: ContextSource): string {
	const attributes = [`kind="${escapeXml(source.kind)}"`, `ref="${escapeXml(source.ref)}"`];
	if (source.previousHash) attributes.push(`previous_hash="${escapeXml(source.previousHash)}"`);
	attributes.push(`hash="${escapeXml(source.hash)}"`);
	if (source.action) attributes.push(`action="${source.action}"`);
	return attributes.join(" ");
}

function staticSection(source: ContextSource, input: ContextInput, imports: ContextImport[]): string {
	if (source.kind === "project_rules") {
		return `  <project_rules>\n${escapeXml(input.projectRules)}\n  </project_rules>`;
	}
	if (source.kind === "shared_rules") {
		return `  <shared_rules>\n${escapeXml(input.sharedRules)}\n  </shared_rules>`;
	}
	const imported = imports.find((candidate) => candidate.ref === source.ref);
	if (!imported) return "";
	return `  <context_import ref="${escapeXml(source.ref)}">\n${escapeXml(imported.content)}\n  </context_import>`;
}

/**
 * Resolve a role's context level from its structured registry entry.
 * Anything unrecognized falls back to "full": over-informing a role is a
 * cost, under-informing it is a correctness risk.
 */
export function resolveLevel(role: { needs_project_rules?: unknown } | null): ContextLevel {
	if (!role) return "full";
	const value = role.needs_project_rules;
	if (value === false) return "none";
	if (value === "shared") return "shared";
	return "full";
}

/**
 * Build the injected context block. Sections a role is not entitled to are
 * omitted entirely rather than emitted as empty sections.
 *
 * A continuation supplies only changed static sources and new fact records.
 * Unchanged source bodies remain earlier in the same Pi session; they are
 * represented here by an auditable manifest entry instead of duplicate text.
 */
export function buildContext(input: ContextInput): ContextBlock {
	const wantsProject = input.level === "full";
	const wantsShared = input.level === "full" || input.level === "shared";
	const imports = input.imports ?? [];

	const staticSources: ContextSource[] = [];
	if (wantsProject) {
		staticSources.push({ kind: "project_rules", ref: "AGENTS.md", hash: sha256(input.projectRules) });
	}
	if (wantsShared) {
		staticSources.push({
			kind: "shared_rules",
			ref: "codeflow/AGENTS.md",
			hash: sha256(input.sharedRules),
		});
	}
	for (const imported of imports) {
		staticSources.push({
			kind: "context_import",
			ref: imported.ref,
			hash: sha256(imported.content),
		});
	}

	const previous = input.previous;
	const previousStatic = new Map(
		(previous?.sources ?? [])
			.filter((source) => source.kind !== "shared_facts")
			.map((source) => [sourceKey(source), source] as const),
	);
	const canDelta =
		previous !== undefined &&
		previousStatic.size === staticSources.length &&
		staticSources.every((source) => previousStatic.has(sourceKey(source)));

	if (!canDelta) {
		const sources: ContextSource[] = [];
		const sections: string[] = [];

		for (const source of staticSources) {
			sources.push(source);
			if (source.kind !== "context_import") {
				const section = staticSection(source, input, imports);
				if (section !== "") sections.push(section);
			}
		}
		if (imports.length > 0) {
			const documents = imports
				.map(
					(imported) =>
						`    <document ref="${escapeXml(imported.ref)}">\n` +
						`${escapeXml(imported.content)}\n` +
						`    </document>`,
				)
				.join("\n");
			sections.push(
				`  <context_imports>\n` +
					`    These declared reference documents are already part of the starting context.\n` +
					`${documents}\n` +
					`  </context_imports>`,
			);
		}

		// The fact ledger is injected for every role regardless of rule level.
		// A pure executor still benefits from knowing where things are, and
		// withholding it would just push it back into redundant searching.
		if (input.facts.trim() !== "") {
			sources.push({ kind: "shared_facts", ref: "facts.jsonl", hash: sha256(input.facts) });
			sections.push(
				`  <shared_facts>\n` +
					`    Facts earlier roles in this run confirmed. Trust the locator, but\n` +
					`    re-read a file before changing it. Later records supersede the earlier\n` +
					`    records they name. If one is wrong, correct it with a superseding fact\n` +
					`    in your receipt instead of arguing in prose.\n` +
					`${escapeXml(input.facts)}\n` +
					`  </shared_facts>`,
			);
		}

		const manifest = sources.map((source) => `    <source ${manifestAttributes(source)} />`).join("\n");
		const body = sections.length > 0 ? "\n" + sections.join("\n") : "";
		const xml =
			`<codeflow_context version="1" mode="full">\n` +
			`  <context_manifest>\n${manifest}\n  </context_manifest>` +
			`${body}\n` +
			`</codeflow_context>`;
		return { xml, sources, mode: "full", factsCursor: input.factsCursor };
	}

	const sources: ContextSource[] = [];
	const sections: string[] = [];
	for (const source of staticSources) {
		const previousSource = previousStatic.get(sourceKey(source));
		if (previousSource === undefined || previousSource.hash === source.hash) {
			sources.push({ ...source, action: "unchanged" });
			continue;
		}

		sources.push({ ...source, action: "replace", previousHash: previousSource.hash });
		const section = staticSection(source, input, imports);
		if (section !== "") sections.push(section);
	}

	const hasNewFacts = input.facts.trim() !== "";
	if (hasNewFacts) {
		sources.push({ kind: "shared_facts", ref: "facts.jsonl", hash: sha256(input.facts), action: "delta" });
		sections.push(
			`  <shared_facts_delta>\n` +
				`    New facts confirmed since the previous handoff. Later records supersede\n` +
				`    the earlier records they name.\n` +
				`${escapeXml(input.facts)}\n` +
				`  </shared_facts_delta>`,
		);
	}

	sections.unshift(
		`  <context_continuity>\n` +
			`    Sources marked unchanged were already injected earlier in this session.\n` +
			`    A source with action="replace" supersedes its earlier version with the same ref.\n` +
			(hasNewFacts ? "" : `    No new shared facts were recorded since the previous handoff.\n`) +
			`  </context_continuity>`,
	);

	const manifest = sources.map((source) => `    <source ${manifestAttributes(source)} />`).join("\n");
	const body = sections.length > 0 ? "\n" + sections.join("\n") : "";
	const xml =
		`<codeflow_context version="1" mode="delta">\n` +
		`  <context_manifest>\n${manifest}\n  </context_manifest>` +
		`${body}\n` +
		`</codeflow_context>`;

	return { xml, sources, mode: "delta", factsCursor: input.factsCursor };
}
