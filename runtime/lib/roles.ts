/**
 * Role resolution: agent Markdown to a concrete pi invocation.
 *
 * The Markdown file *is* the role. Its frontmatter binds the model and
 * permissions, its body is the system prompt. Keeping both in one file means a
 * role's behaviour is explained by one artifact rather than split between a
 * prompt and a config table that can disagree with it.
 *
 * Frontmatter parsing is deliberately shallow — top-level `key: value` only.
 * Nested structure would invite configuration that the prompt does not
 * mention, which is exactly what makes agent behaviour hard to reason about.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Exactly the keys a role may declare. Anything else is rejected. */
export const ALLOWED_KEYS = new Set([
	"description",
	"model",
	"tools",
	"delegates",
	"needs_project_rules",
	"goal_lane",
]);

export interface Frontmatter {
	description?: string;
	model?: string;
	tools?: string;
	delegates?: string;
	needs_project_rules?: string;
	goal_lane?: string;
}

export interface ResolvedRole {
	role: string;
	provider: string;
	model: string;
	systemPrompt: string;
	tools: string[];
	delegates: boolean;
	goalLane?: string;
}

export class RoleError extends Error {}

/** Parse top-level `key: value` pairs from a Markdown frontmatter block. */
export function parseFrontmatter(text: string): Frontmatter {
	const fields: Record<string, string> = {};
	let opened = false;
	for (const line of text.split("\n")) {
		if (line.trim() === "---") {
			if (opened) break;
			opened = true;
			continue;
		}
		if (!opened) continue;
		if (line.includes(":") && !/^[ \t]/.test(line)) {
			const index = line.indexOf(":");
			fields[line.slice(0, index).trim()] = line.slice(index + 1).trim();
		}
	}
	return fields as Frontmatter;
}

export function agentFile(agentsDir: string, role: string): string {
	return path.join(agentsDir, `${role}.md`);
}

export function listRoles(agentsDir: string): string[] {
	try {
		return fs
			.readdirSync(agentsDir)
			.filter((name) => name.endsWith(".md"))
			.map((name) => name.slice(0, -3))
			.sort();
	} catch {
		return [];
	}
}

export function readFrontmatter(agentsDir: string, role: string): Frontmatter | null {
	const file = agentFile(agentsDir, role);
	if (!fs.existsSync(file)) return null;
	return parseFrontmatter(fs.readFileSync(file, "utf-8"));
}

/**
 * Resolve a role to the provider, model, prompt, and tool allowlist pi needs.
 *
 * Returns null for an unknown role so the caller can report it as such rather
 * than surfacing a filesystem error.
 */
export function resolveRole(agentsDir: string, role: string): ResolvedRole | null {
	const frontmatter = readFrontmatter(agentsDir, role);
	if (frontmatter === null) return null;

	const binding = frontmatter.model ?? "";
	if (!binding.includes("/")) {
		throw new RoleError(`agent ${role}: frontmatter model must be '<provider>/<model>'`);
	}
	const separator = binding.indexOf("/");
	if (
		frontmatter.goal_lane &&
		!/^(?:test|code|verify)$/.test(frontmatter.goal_lane)
	) {
		throw new RoleError(
			`agent ${role}: goal_lane must be test, code, or verify`,
		);
	}

	return {
		role,
		provider: binding.slice(0, separator),
		model: binding.slice(separator + 1),
		systemPrompt: agentFile(agentsDir, role),
		tools: (frontmatter.tools ?? "")
			.split(",")
			.map((token) => token.trim())
			.filter(Boolean),
		// Strict equality: a role delegates only when it says so exactly.
		delegates: frontmatter.delegates === "true",
		goalLane: frontmatter.goal_lane,
	};
}

/**
 * Build the pi command line.
 *
 * Extensions load in a fixed order — delegation, context, liveness — and
 * `--no-context-files` means nothing is picked up implicitly. Whatever steers
 * a role is injected visibly by the context extension instead.
 */
export function buildArgv(
	resolved: ResolvedRole,
	prompt: string,
	extensions: string[],
	session?: { id: string; dir: string },
): string[] {
	const argv = [
		"pi",
		"-p", prompt,
		"--mode", "json",
		"--provider", resolved.provider,
		"--model", resolved.model,
		"--system-prompt", resolved.systemPrompt,
	];
	for (const extension of extensions) {
		argv.push("--extension", extension);
	}
	argv.push("--no-context-files");
	if (resolved.tools.length > 0) {
		argv.push("--tools", resolved.tools.join(","));
	}
	if (session) {
		argv.push("--session-id", session.id, "--session-dir", session.dir);
	}
	return argv;
}
