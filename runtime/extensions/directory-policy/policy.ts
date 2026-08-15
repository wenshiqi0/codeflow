/**
 * Role-configurable directory policy. This pure module is shared by the Pi
 * extension and tests; it never mutates project files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGoal } from "../../lib/goals";
import { DEFAULT_RUNS_DIR, RunPaths } from "../../lib/paths";

export const BUSINESS_TEST_ROOT = "tests/biz";

export type WriteMode = "allow" | "deny";
export type BashMode = "codeflow-only" | "read-only" | "guarded-work" | "unrestricted";

export interface RolePolicyConfig {
	goalLane?: "test" | "code" | "verify";
	writeMode?: WriteMode;
	writeRoots?: string[];
	bashMode?: BashMode;
}

export function rolePolicyConfig(role: string | undefined): RolePolicyConfig | null {
	if (!role) return null;
	const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	const file = path.join(runtimeDir, "agents", `${role}.md`);
	if (!fs.existsSync(file)) return null;
	const fields: Record<string, string> = {};
	let opened = false;
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (line.trim() === "---") {
			if (opened) break;
			opened = true;
			continue;
		}
		if (!opened || !line.includes(":") || /^[ \t]/.test(line)) continue;
		const index = line.indexOf(":");
		fields[line.slice(0, index).trim()] = line.slice(index + 1).trim();
	}
	const frontmatter = fields;
	if (!frontmatter.write_policy && !frontmatter.bash_policy && !frontmatter.goal_lane) return null;

	const config: RolePolicyConfig = {};
	if (frontmatter.goal_lane) {
		if (!/^(?:test|code|verify)$/.test(frontmatter.goal_lane)) {
			throw new Error(`invalid goal_lane for ${role}: ${frontmatter.goal_lane}`);
		}
		config.goalLane = frontmatter.goal_lane as "test" | "code" | "verify";
	}
	if (frontmatter.write_policy) {
		const [rawMode, rawRoots] = frontmatter.write_policy.split(":", 2);
		if (rawMode === "none") {
			config.writeMode = "deny";
			config.writeRoots = ["."];
		} else {
			if (rawMode !== "allow" && rawMode !== "deny") {
				throw new Error(`invalid write_policy mode for ${role}: ${rawMode}`);
			}
			config.writeMode = rawMode;
			config.writeRoots = (rawRoots ?? "")
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean);
			if (rawMode === "allow" && config.writeRoots.length !== 1) {
				throw new Error(`allow write_policy requires exactly one policy root for ${role}`);
			}
		}
	}
	if (frontmatter.bash_policy) {
		const mode = frontmatter.bash_policy;
		if (!/^(?:codeflow-only|read-only|guarded-work|unrestricted)$/.test(mode)) {
			throw new Error(`invalid bash_policy for ${role}: ${mode}`);
		}
		config.bashMode = mode as BashMode;
	}
	return config;
}

function normalizedAbsolute(cwd: string, value: string): string {
	return path.resolve(cwd, value).split(path.sep).join("/");
}

function realPath(target: string): string {
	try {
		return fs.realpathSync(target).split(path.sep).join("/");
	} catch {
		const parent = path.dirname(target);
		if (parent === target) return target;
		return path.join(realPath(parent), path.basename(target)).split(path.sep).join("/");
	}
}

function inside(root: string, target: string): boolean {
	if (root === target) return true;
	const relative = path.relative(root, target);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export interface ResolvedPathPolicy {
	mode: WriteMode;
	roots: string[];
	source: "role" | "goal";
}

export function resolvePathPolicy(
	role: string | undefined,
	cwd: string,
	goalId?: string,
	lane?: string,
): ResolvedPathPolicy | null {
	const config = rolePolicyConfig(role);
	if (!config?.writeMode || !config.writeRoots) return null;

	let mode = config.writeMode;
	let roots = config.writeRoots;
	let source: "role" | "goal" = "role";
	const policyRoot = roots[0];

	if (policyRoot === "goal") {
		const runId = process.env.CODEFLOW_RUN_ID;
		if (!goalId || !lane || !runId) {
			return {
				mode: "allow",
				roots: [],
				source: "role",
			};
		}
		if (config.goalLane !== lane) {
			throw new Error(`role ${role} is not configured for goal lane ${lane}`);
		}
		const paths = new RunPaths(process.env.CODEFLOW_RUNS_DIR ?? DEFAULT_RUNS_DIR, runId);
		const goal = loadGoal(paths, goalId);
		if (goal.lanes[lane].role !== role) {
			throw new Error(`role ${role} does not own goal ${goalId} lane ${lane}`);
		}
		roots = goal.lanes[lane].write_roots;
		source = "goal";
	}

	return {
		mode,
		roots: roots.map((root) => normalizedAbsolute(cwd, root)),
		source,
	};
}

export function pathViolation(
	role: string | undefined,
	cwd: string,
	value: string,
	goalIdArgument?: string,
	laneArgument?: string,
): string | null {
	const goalId = goalIdArgument ?? process.env.CODEFLOW_GOAL_ID;
	const lane = laneArgument ?? process.env.CODEFLOW_LANE;
	const policy = resolvePathPolicy(role, cwd, goalId, lane);
	if (!policy) return null;

	const realCwd = realPath(cwd);
	const lexicalTarget = normalizedAbsolute(cwd, value);
	const target = realPath(lexicalTarget);
	const roots = policy.roots
		.map((root) => {
			const expected = path.join(realCwd, path.relative(cwd, root)).split(path.sep).join("/");
			return { lexical: root, real: realPath(root), expected };
		})
		.filter((root) => root.real === root.expected)
		.map((root) => root.real);
	if (!inside(realCwd, target)) {
		return `${role} file access must stay inside the repository: ${value}`;
	}

	if (policy.mode === "allow") {
		const allowed = roots.some((root) => inside(root, target));
		if (!allowed) {
			const displayRoots = roots.map((root) => path.relative(cwd, root) || ".").join(", ");
			return `${role} may write only under: ${displayRoots}`;
		}
		return null;
	}

	const denied = roots.some((root) => inside(root, target));
	if (denied) {
		return `${role} is denied writes under: ${policy.roots.join(", ")}`;
	}
	return null;
}

const SHELL_COMPOSITION = /[\r\n;|<>`]|\$\(/;
const CODEFLOW_ONLY = /^code-agent\s+handoff\s+finish(?:\s|$)/;
const READ_COMMAND =
	/^(?:pwd|ls|cat|head|tail|find|rg|grep|git\s+(?:status|diff|log)|npm\s+(?:view|info)|code-agent\s+(?:(?:check|verify)\s+(?:source|patch)|handoff\s+finish))(?:\s|$)/;
const WORK_COMMAND =
	/^(?:node|npm|npx|bun|vitest|tsc|eslint|cargo|rustc|pytest|go|make|git\s+(?:status|diff)|code-agent\s+(?:(?:check|verify)\s+(?:source|patch)|handoff\s+finish))(?:\s|$)/;

export function bashViolation(role: string | undefined, command: string): string | null {
	const config = rolePolicyConfig(role);
	if (!config?.bashMode || config.bashMode === "unrestricted") return null;
	const trimmed = command.trim();

	if (SHELL_COMPOSITION.test(trimmed)) {
		return `${role} bash may not use shell composition or redirection`;
	}
	if (/\b(?:node|bun)\b[^\n]*\s(?:-e|--eval)\b/.test(trimmed)) {
		return `${role} bash may not evaluate inline code`;
	}
	if (config.bashMode === "codeflow-only" && !CODEFLOW_ONLY.test(trimmed)) {
		return `${role} bash is limited to "code-agent handoff finish"`;
	}
	if (config.bashMode === "read-only" && !READ_COMMAND.test(trimmed)) {
		return `${role} bash is limited to read-only inspection commands`;
	}
	if (config.bashMode === "guarded-work" && !WORK_COMMAND.test(trimmed)) {
		return `${role} bash command is outside the development allowlist`;
	}
	return null;
}
