/**
 * Goals are immutable contracts plus a read-only join over
 * handoffs. There is deliberately no goal state machine: handoff state,
 * receipts, and artifacts remain the only authoritative execution state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type HandoffState, handoffHistory } from "./handoff";
import { RunPaths, readJson, slug, writeJsonAtomic } from "./paths";
import { deliverEvent, eventSummary } from "./events";

export const GOAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const GOAL_LANES = ["test", "code", "verify"] as const;
export type GoalLane = (typeof GOAL_LANES)[number];

export class GoalError extends Error {}

export interface GoalLaneContract {
	role: string;
	write_roots: string[];
}

export interface GoalContract {
	schema_version: 1;
	id: string;
	goal: string;
	definition_of_done: string[];
	created_at: string;
	lanes: Record<GoalLane, GoalLaneContract>;
}

export interface DefineGoalOptions {
	id: string;
	goal: string;
	testScope?: string[];
	codeScope?: string[];
	definitionOfDone?: string[];
}

function repoRelative(value: string, label: string): string {
	if (!value || path.isAbsolute(value)) {
		throw new GoalError(`${label} must be a non-empty repository-relative path`);
	}
	const normalized = path.normalize(value).split(path.sep).join("/");
	if (
		normalized === "." ||
		normalized.startsWith("../") ||
		normalized.includes("/../") ||
		normalized === ".."
	) {
		throw new GoalError(`${label} must stay inside the repository: ${value}`);
	}
	return normalized.replace(/\/+$/, "");
}

function scopeList(values: string[] | undefined, label: string): string[] {
	return (values ?? []).map((value) => repoRelative(value, label));
}

function evidenceLaneRoot(paths: RunPaths, goalId: string, lane: GoalLane): string {
	return path.posix.join(
		".codeflow/runs/evidence",
		slug(paths.runId),
		"goals",
		slug(goalId),
		lane,
	);
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort();
}

export function defineGoal(
	paths: RunPaths,
	options: DefineGoalOptions,
): { goal_id: string; contract: string; idempotent: boolean } {
	const goalId = slug(options.id);
	if (!GOAL_ID_PATTERN.test(goalId)) {
		throw new GoalError(`goal id must match ${GOAL_ID_PATTERN}: ${options.id}`);
	}
	const goal = options.goal?.trim();
	if (!goal) throw new GoalError("goal must be a non-empty string");

	const testScope = scopeList(options.testScope, "test scope");
	const codeScope = scopeList(options.codeScope, "code scope");
	const testRoot = `tests/biz/${goalId}`;
	for (const entry of testScope) {
		if (entry !== testRoot && !entry.startsWith(`${testRoot}/`)) {
			throw new GoalError(`test scope must stay under ${testRoot}/: ${entry}`);
		}
	}
	for (const entry of codeScope) {
		if (
			entry.startsWith(".codeflow/") ||
			entry.startsWith("tests/biz/") ||
			entry.startsWith("tests/unit/") ||
			entry.startsWith("tests/fixtures/")
		) {
			throw new GoalError(
				`code scope may contain product paths only; test and run roots are derived: ${entry}`,
			);
		}
	}

	const contract: GoalContract = {
		schema_version: 1,
		id: goalId,
		goal,
		definition_of_done: uniqueSorted((options.definitionOfDone ?? []).map((entry) => entry.trim()).filter(Boolean)),
		created_at: new Date().toISOString(),
		lanes: {
			test: {
				role: "test-writer",
				write_roots: uniqueSorted([testRoot, evidenceLaneRoot(paths, goalId, "test")]),
			},
			code: {
				role: "coder",
				write_roots: uniqueSorted([
					...codeScope,
					`tests/unit/${goalId}`,
					`tests/fixtures/${goalId}`,
					evidenceLaneRoot(paths, goalId, "code"),
				]),
			},
			verify: {
				role: "test-runner",
				write_roots: [evidenceLaneRoot(paths, goalId, "verify")],
			},
		},
	};

	const file = paths.goalContractPath(goalId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (fs.existsSync(file)) {
		const existing = readJson<GoalContract>(file);
		const canonical = {
			...existing,
			created_at: contract.created_at,
		};
		if (JSON.stringify(canonical) !== JSON.stringify(contract)) {
			throw new GoalError(`goal contract already exists with different content: ${goalId}`);
		}
		return { goal_id: goalId, contract: path.relative(process.cwd(), file), idempotent: true };
	}
	writeJsonAtomic(file, contract);
	deliverEvent({
		stagingDir: paths.tmp,
		targetDir: paths.events,
		counterPath: paths.eventSeq,
		subject: goalId,
		kind: "artifact_written",
		status: "WRITTEN",
		payload: {
			ref: path.relative(process.cwd(), file),
			summary: eventSummary(`goal contract: ${goal}`),
		},
	});
	return { goal_id: goalId, contract: path.relative(process.cwd(), file), idempotent: false };
}

export function loadGoal(paths: RunPaths, goalId: string): GoalContract {
	const file = paths.goalContractPath(slug(goalId));
	if (!fs.existsSync(file)) throw new GoalError(`unknown goal: ${goalId}`);
	const contract = readJson<GoalContract>(file);
	if (contract.schema_version !== 1) throw new GoalError(`unsupported goal contract schema: ${goalId}`);
	return contract;
}

export function goalSessionId(runId: string, goalId: string, lane: GoalLane): string {
	if (!runId || !GOAL_ID_PATTERN.test(slug(goalId))) {
		throw new GoalError(`invalid goal session run/goal: ${runId}/${goalId}`);
	}
	if (!GOAL_LANES.includes(lane)) throw new GoalError(`invalid goal lane: ${lane}`);
	return `${runId}-${slug(goalId)}-${lane}`;
}

export function goalContracts(paths: RunPaths): GoalContract[] {
	if (!fs.existsSync(paths.goals)) return [];
	return fs
		.readdirSync(paths.goals, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => loadGoal(paths, entry.name))
		.sort((left, right) => left.id.localeCompare(right.id));
}

export interface GoalLaneView {
	role: string;
	latest_handoff: {
		id: string;
		status: HandoffState["status"];
		result: HandoffState["result"] | null;
		blocked_reasons: string[];
	} | null;
	handoff_count: number;
	open_count: number;
	pass_count: number;
	fail_count: number;
	blocked_count: number;
}

export interface GoalView {
	goal_id: string;
	goal: string;
	definition_of_done: string[];
	lanes: Record<GoalLane, GoalLaneView>;
	join: {
		satisfied: boolean;
		unsatisfied: string[];
	};
}

export function goalView(paths: RunPaths, contract: GoalContract): GoalView {
	const handoffSequence = (id: string): number => {
		const parsed = Number.parseInt(id.slice(1), 10);
		return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
	};
	const states = handoffHistory(paths)
		.filter((state) => state.goal_id === contract.id)
		.sort((left, right) => handoffSequence(left.handoff_id) - handoffSequence(right.handoff_id));
	const lanes = {} as Record<GoalLane, GoalLaneView>;
	const unsatisfied: string[] = [];

	for (const lane of GOAL_LANES) {
		const laneContract = contract.lanes[lane];
		const laneStates = states.filter((state) => state.lane === lane);
		const latest = laneStates.at(-1) ?? null;
		lanes[lane] = {
			role: laneContract.role,
			latest_handoff: latest
				? {
					id: latest.handoff_id,
					status: latest.status,
					result: latest.result ?? null,
					blocked_reasons: [
						...(((latest.blocked as { reasons?: unknown } | undefined)?.reasons ?? []) as string[]),
					],
				}
				: null,
			handoff_count: laneStates.length,
			open_count: laneStates.filter((state) => state.status === "open" || state.status === "running").length,
			pass_count: laneStates.filter((state) => state.status === "done" && state.result === "PASS").length,
			fail_count: laneStates.filter((state) => state.status === "done" && state.result === "FAIL").length,
			blocked_count: laneStates.filter((state) => state.status === "blocked").length,
		};
		if (!latest || latest.status !== "done" || latest.result !== "PASS") {
			unsatisfied.push(`${lane}: latest handoff PASS`);
		}
	}

	return {
		goal_id: contract.id,
		goal: contract.goal,
		definition_of_done: contract.definition_of_done,
		lanes,
		join: {
			satisfied: unsatisfied.length === 0,
			unsatisfied,
		},
	};
}

export function goalViews(paths: RunPaths): GoalView[] {
	return goalContracts(paths).map((contract) => goalView(paths, contract));
}
