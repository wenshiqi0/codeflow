/**
 * Role resolution from the structured runtime registry.
 *
 * `runtime/roles.json` owns machine policy (model, tools, lanes). Role behavior
 * lives in one prompt below `references/capabilities/`. Keeping those concerns
 * separate removes the old duplicate agent Markdown layer while preserving one
 * auditable source for each kind of truth.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const ALLOWED_KEYS = new Set([
	"description",
	"model",
	"prompt",
	"tools",
	"delegates",
	"needs_project_rules",
	"goal_lane",
	"handoff_round_cap",
	"internal",
]);

export interface RoleDefinition {
	description: string;
	model: string;
	prompt: string;
	tools?: string[];
	delegates?: boolean;
	needs_project_rules?: false | "shared" | "full";
	goal_lane?: "test" | "code" | "verify";
	/** Completed assistant rounds allowed in one handoff; zero disables the cap. */
	handoff_round_cap?: number;
	internal?: boolean;
}

interface RoleRegistry {
	roles: Record<string, RoleDefinition>;
}

export interface ResolvedRole {
	role: string;
	description: string;
	provider: string;
	model: string;
	systemPrompt: string;
	promptPath: string;
	tools: string[];
	delegates: boolean;
	needsProjectRules: false | "shared" | "full";
	goalLane?: "test" | "code" | "verify";
	handoffRoundCap?: number;
	internal: boolean;
}

export class RoleError extends Error {}

const ROLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function fail(message: string): never {
	throw new RoleError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadRegistry(registryFile: string): RoleRegistry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(registryFile, "utf-8"));
	} catch (error) {
		fail(`cannot read role registry ${registryFile}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed) || !isRecord(parsed.roles)) {
		fail(`role registry ${registryFile} must contain a roles object`);
	}

	const roles: Record<string, RoleDefinition> = {};
	for (const [role, value] of Object.entries(parsed.roles)) {
		if (!ROLE_NAME_PATTERN.test(role)) fail(`invalid role name in registry: ${role}`);
		if (!isRecord(value)) fail(`role ${role}: configuration must be an object`);
		for (const key of Object.keys(value)) {
			if (!ALLOWED_KEYS.has(key)) fail(`role ${role}: unknown configuration key ${key}`);
		}
		if (typeof value.description !== "string" || value.description.trim() === "") {
			fail(`role ${role}: description must be a non-empty string`);
		}
		if (typeof value.model !== "string" || value.model.trim() === "") {
			fail(`role ${role}: model must be a non-empty string`);
		}
		if (typeof value.prompt !== "string" || value.prompt.trim() === "") {
			fail(`role ${role}: prompt must be a non-empty string`);
		}
		if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.some((tool) => typeof tool !== "string" || tool.trim() === ""))) {
			fail(`role ${role}: tools must be an array of non-empty strings`);
		}
		if (value.delegates !== undefined && typeof value.delegates !== "boolean") {
			fail(`role ${role}: delegates must be boolean`);
		}
		if (value.internal !== undefined && typeof value.internal !== "boolean") {
			fail(`role ${role}: internal must be boolean`);
		}
		if (value.needs_project_rules !== undefined && value.needs_project_rules !== false && value.needs_project_rules !== "shared" && value.needs_project_rules !== "full") {
			fail(`role ${role}: needs_project_rules must be false, shared, or full`);
		}
		if (value.goal_lane !== undefined && !/^(?:test|code|verify)$/.test(String(value.goal_lane))) {
			fail(`role ${role}: goal_lane must be test, code, or verify`);
		}
		if (
			value.handoff_round_cap !== undefined &&
			(typeof value.handoff_round_cap !== "number" ||
				!Number.isInteger(value.handoff_round_cap) ||
				value.handoff_round_cap < 0)
		) {
			fail(`role ${role}: handoff_round_cap must be a non-negative integer`);
		}
		roles[role] = value as unknown as RoleDefinition;
	}
	return { roles };
}

export function listRoles(registryFile: string): string[] {
	try {
		return Object.keys(loadRegistry(registryFile).roles).sort();
	} catch (error) {
		if (!fs.existsSync(registryFile)) return [];
		throw error;
	}
}

export function readRoleDefinition(registryFile: string, role: string): RoleDefinition | null {
	return loadRegistry(registryFile).roles[role] ?? null;
}

function resolvePrompt(registryFile: string, role: string, ref: string): string {
	const runtimeDir = path.dirname(registryFile);
	const packageRoot = path.dirname(runtimeDir);
	const referencesRoot = path.resolve(packageRoot, "references");
	const promptPath = path.resolve(packageRoot, ref);
	const relative = path.relative(referencesRoot, promptPath);
	if (!promptPath.endsWith(".md") || relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		fail(`role ${role}: prompt must be Markdown below references/: ${ref}`);
	}
	try {
		const realRoot = fs.realpathSync(referencesRoot);
		const realPrompt = fs.realpathSync(promptPath);
		const realRelative = path.relative(realRoot, realPrompt);
		if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
			fail(`role ${role}: prompt escapes references/: ${ref}`);
		}
		return realPrompt;
	} catch (error) {
		if (error instanceof RoleError) throw error;
		fail(`role ${role}: prompt is unreadable: ${ref}`);
	}
}

export function resolveRole(registryFile: string, role: string): ResolvedRole | null {
	const definition = readRoleDefinition(registryFile, role);
	if (definition === null) return null;

	const separator = definition.model.indexOf("/");
	if (separator <= 0 || separator === definition.model.length - 1) {
		fail(`role ${role}: model must be '<provider>/<model>'`);
	}
	const promptPath = resolvePrompt(registryFile, role, definition.prompt);
	return {
		role,
		description: definition.description,
		provider: definition.model.slice(0, separator),
		model: definition.model.slice(separator + 1),
		systemPrompt: fs.readFileSync(promptPath, "utf-8"),
		promptPath,
		tools: (definition.tools ?? []).map((tool) => tool.trim()),
		delegates: definition.delegates === true,
		needsProjectRules: definition.needs_project_rules ?? "full",
		goalLane: definition.goal_lane,
		handoffRoundCap: definition.handoff_round_cap,
		internal: definition.internal === true,
	};
}

/** Build the explicit Pi invocation for a resolved role. */
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
	for (const extension of extensions) argv.push("--extension", extension);
	argv.push("--no-context-files");
	if (resolved.tools.length > 0) argv.push("--tools", resolved.tools.join(","));
	if (session) argv.push("--session-id", session.id, "--session-dir", session.dir);
	return argv;
}
