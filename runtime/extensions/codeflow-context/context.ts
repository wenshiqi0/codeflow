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
}

export interface ContextInput {
	level: ContextLevel;
	projectRules: string;
	sharedRules: string;
	imports?: ContextImport[];
	facts: string;
	generatedAt: string;
}

export interface ContextBlock {
	xml: string;
	sources: ContextSource[];
}

export function sha256(input: string): string {
	return "sha256:" + createHash("sha256").update(input).digest("hex");
}

/** Escape text embedded in XML content. */
export function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Resolve a role's context level from its agent frontmatter.
 * Anything unrecognized falls back to "full": over-informing a role is a
 * cost, under-informing it is a correctness risk.
 */
export function resolveLevel(frontmatter: Record<string, unknown> | null): ContextLevel {
	if (!frontmatter) return "full";
	const value = frontmatter.needs_project_rules;
	if (value === false || value === "false") return "none";
	if (value === "shared") return "shared";
	return "full";
}

/**
 * Build the injected context block. Sections a role is not entitled to are
 * omitted entirely rather than emitted empty, so the block shows exactly
 * what the role was given.
 */
export function buildContext(input: ContextInput): ContextBlock {
	const wantsProject = input.level === "full";
	const wantsShared = input.level === "full" || input.level === "shared";

	const sources: ContextSource[] = [];
	const sections: string[] = [];

	if (wantsProject) {
		sources.push({ kind: "project_rules", ref: "AGENTS.md", hash: sha256(input.projectRules) });
		sections.push(`  <project_rules>\n${escapeXml(input.projectRules)}\n  </project_rules>`);
	}
	if (wantsShared) {
		sources.push({
			kind: "shared_rules",
			ref: "codeflow/AGENTS.md",
			hash: sha256(input.sharedRules),
		});
		sections.push(`  <shared_rules>\n${escapeXml(input.sharedRules)}\n  </shared_rules>`);
	}

	const imports = input.imports ?? [];
	if (imports.length > 0) {
		const documents = imports
			.map(
				(imported) =>
					`    <document ref="${escapeXml(imported.ref)}">\n` +
					`${escapeXml(imported.content)}\n` +
					`    </document>`,
			)
			.join("\n");
		for (const imported of imports) {
			sources.push({
				kind: "context_import",
				ref: imported.ref,
				hash: sha256(imported.content),
			});
		}
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
				`    re-read a file before changing it. If one is wrong, correct it with a\n` +
				`    superseding fact in your receipt instead of arguing in prose.\n` +
				`${escapeXml(input.facts)}\n` +
				`  </shared_facts>`,
		);
	}

	const manifest = sources
		.map((source) => `    <source kind="${source.kind}" ref="${source.ref}" hash="${source.hash}" />`)
		.join("\n");

	const body = sections.length > 0 ? "\n" + sections.join("\n") : "";
	const xml =
		`<codeflow_context version="1">\n` +
		`  <context_manifest generated_at="${input.generatedAt}">\n${manifest}\n  </context_manifest>` +
		`${body}\n` +
		`</codeflow_context>`;

	return { xml, sources };
}
