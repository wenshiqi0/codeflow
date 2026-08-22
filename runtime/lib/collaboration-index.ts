import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type HandoffState, handoffHistory } from "./handoff";
import { loadGoal, type GoalLane } from "./goals";
import { readJson, RunPaths, writeJsonAtomic } from "./paths";

export const UNLANED_GOAL_ID = "_unlaned";
export const HANDOFF_INDEX_SCHEMA_VERSION = 1;
export const DEFAULT_HANDOFF_INDEX_LIMIT = 20;
export const MAX_HANDOFF_INDEX_LIMIT = 50;

export type HandoffIndexPhase = "open" | "final";

export interface HandoffIndexCard {
	schema_version: 1;
	kind: "handoff_index_card";
	phase: HandoffIndexPhase;
	goal_id: string | null;
	handoff_id: string;
	role: string;
	lane: GoalLane | null;
	status: HandoffState["status"];
	result: HandoffState["result"] | null;
	blocked_reasons: string[];
	title: string;
	digest: string;
	established: string[];
	decided: string[];
	ruled_out: string[];
	changed_files: string[];
	evidence_refs: string[];
	uncertainties: string[];
	body_ref: string;
	receipt_ref: string | null;
	source: {
		body_hash: string;
		receipt_hash: string | null;
	};
	generator: {
		kind: "zipper" | "deterministic";
		generated_at: string;
	};
	fallback: boolean;
}

export interface HandoffIndexQuery {
	goalId?: string;
	unlaned?: boolean;
	lane?: string;
	status?: string;
	role?: string;
	query?: string;
	limit?: number;
}

export interface HandoffRecall {
	state: HandoffState;
	index_card: HandoffIndexCard | null;
	body: string;
	receipt: Record<string, unknown> | null;
}

function sha256(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function blockedReasons(state: HandoffState): string[] {
	const blocked = state.blocked as { reasons?: unknown } | undefined;
	if (!blocked || !Array.isArray(blocked.reasons)) return [];
	return blocked.reasons.filter((reason): reason is string => typeof reason === "string");
}

function titleForState(paths: RunPaths, state: HandoffState): string {
	const titleFile = paths.titlePath(state.handoff_id);
	if (fs.existsSync(titleFile)) {
		const title = fs.readFileSync(titleFile, "utf8").trim().split("\n")[0]?.trim();
		if (title) return title.slice(0, 160);
	}
	const bodyFile = path.join(paths.handoffDir(state.handoff_id), "handoff.md");
	if (fs.existsSync(bodyFile)) {
		for (const line of fs.readFileSync(bodyFile, "utf8").split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			return trimmed.replace(/^[-*]+\s*/, "").slice(0, 160);
		}
	}
	return state.goal?.slice(0, 160) ?? state.handoff_id;
}

function boundedList(value: unknown, limit = 8): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
		.map((entry) => entry.trim().slice(0, 180))
		.slice(0, limit);
}

function readBody(paths: RunPaths, handoffId: string): string {
	const file = path.join(paths.handoffDir(handoffId), "handoff.md");
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function readReceipt(paths: RunPaths, handoffId: string): Record<string, unknown> | null {
	const file = paths.receiptPath(handoffId);
	if (!fs.existsSync(file)) return null;
	try {
		return readJson<Record<string, unknown>>(file);
	} catch {
		return null;
	}
}

function digestFromBody(body: string, state: HandoffState): string {
	const source = state.summary?.trim() || body.trim();
	return source.slice(0, 600);
}

export function buildHandoffIndexCard(
	paths: RunPaths,
	state: HandoffState,
	phase: HandoffIndexPhase,
): HandoffIndexCard {
	const body = readBody(paths, state.handoff_id);
	const receipt = readReceipt(paths, state.handoff_id);
	const receiptText = receipt === null ? "" : JSON.stringify(receipt);
	return {
		schema_version: HANDOFF_INDEX_SCHEMA_VERSION,
		kind: "handoff_index_card",
		phase,
		goal_id: state.goal_id ?? null,
		handoff_id: state.handoff_id,
		role: state.role,
		lane: state.lane ?? null,
		status: state.status,
		result: state.result ?? null,
		blocked_reasons: blockedReasons(state),
		title: titleForState(paths, state),
		digest: digestFromBody(body, state),
		established: boundedList(receipt?.established),
		decided: boundedList(receipt?.decided),
		ruled_out: boundedList(receipt?.ruled_out),
		changed_files: boundedList(receipt?.changed_files),
		evidence_refs: boundedList([
			...(Array.isArray(receipt?.artifacts) ? (receipt?.artifacts as unknown[]) : []),
			...(Array.isArray(receipt?.evidence_refs) ? (receipt?.evidence_refs as unknown[]) : []),
		]),
		uncertainties: boundedList(receipt?.uncertainties),
		body_ref: path.join("handoffs", state.handoff_id, "handoff.md"),
		receipt_ref: receipt === null ? null : path.join("handoffs", state.handoff_id, "receipt.json"),
		source: {
			body_hash: sha256(body),
			receipt_hash: receipt === null ? null : sha256(receiptText),
		},
		generator: {
			kind: "deterministic",
			generated_at: new Date().toISOString(),
		},
		fallback: true,
	};
}

export function handoffIndexCardPath(
	paths: RunPaths,
	handoffId: string,
	phase: HandoffIndexPhase,
): string {
	const goalId = handoffHistory(paths).find((state) => state.handoff_id === handoffId)?.goal_id;
	return path.join(paths.collaborationIndexDir(goalId ?? UNLANED_GOAL_ID), `${handoffId}.${phase}.json`);
}

export function writeDeterministicHandoffIndexCard(
	paths: RunPaths,
	state: HandoffState,
	phase: HandoffIndexPhase,
): HandoffIndexCard {
	const card = buildHandoffIndexCard(paths, state, phase);
	writeJsonAtomic(handoffIndexCardPath(paths, state.handoff_id, phase), card);
	return card;
}

function cardMatches(card: HandoffIndexCard, query: HandoffIndexQuery): boolean {
	if (query.lane !== undefined && card.lane !== query.lane) return false;
	if (query.role !== undefined && card.role !== query.role) return false;
	if (query.status !== undefined) {
		const status = card.status === "done" && card.result ? card.result.toLowerCase() : card.status;
		if (status !== query.status.toLowerCase()) return false;
	}
	if (query.query !== undefined) {
		const needle = query.query.toLowerCase();
		const haystack = [
			card.title,
			card.digest,
			...card.established,
			...card.decided,
			...card.ruled_out,
			...card.changed_files,
		].join("\n").toLowerCase();
		if (!haystack.includes(needle)) return false;
	}
	return true;
}

function preferredCard(paths: RunPaths, state: HandoffState): HandoffIndexCard {
	const goalId = state.goal_id ?? UNLANED_GOAL_ID;
	for (const phase of ["final", "open"] as const) {
		const file = path.join(paths.collaborationIndexDir(goalId), `${state.handoff_id}.${phase}.json`);
		if (!fs.existsSync(file)) continue;
		try {
			const card = readJson<HandoffIndexCard>(file);
			if (card.schema_version === HANDOFF_INDEX_SCHEMA_VERSION && card.handoff_id === state.handoff_id) {
				return card;
			}
		} catch {
			// A damaged derived card is never worth failing discovery; rebuild below.
		}
	}
	return buildHandoffIndexCard(paths, state, state.status === "open" || state.status === "running" ? "open" : "final");
}

function handoffSequence(id: string): number {
	const parsed = Number.parseInt(id.slice(1), 10);
	return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function resolveIndexScope(paths: RunPaths, query: HandoffIndexQuery): string {
	if (query.unlaned) return UNLANED_GOAL_ID;
	const goalId = query.goalId ?? process.env.CODEFLOW_GOAL_ID;
	if (!goalId) {
		throw new Error("handoff index requires --goal-id when no ambient CODEFLOW_GOAL_ID is set");
	}
	loadGoal(paths, goalId);
	return goalId;
}

export function listHandoffIndex(paths: RunPaths, query: HandoffIndexQuery = {}): HandoffIndexCard[] {
	const goalId = resolveIndexScope(paths, query);
	const limit = query.limit ?? DEFAULT_HANDOFF_INDEX_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HANDOFF_INDEX_LIMIT) {
		throw new Error(`handoff index limit must be between 1 and ${MAX_HANDOFF_INDEX_LIMIT}`);
	}
	return handoffHistory(paths)
		.filter((state) => query.unlaned ? state.goal_id === undefined : state.goal_id === goalId)
		.sort((left, right) => handoffSequence(left.handoff_id) - handoffSequence(right.handoff_id))
		.map((state) => preferredCard(paths, state))
		.filter((card) => cardMatches(card, query))
		.slice(0, limit);
}

export function recallHandoff(paths: RunPaths, handoffId: string): HandoffRecall {
	const state = handoffHistory(paths).find((candidate) => candidate.handoff_id === handoffId);
	if (!state) throw new Error(`handoff not found: ${handoffId}`);
	return {
		state,
		index_card: preferredCard(paths, state),
		body: readBody(paths, handoffId),
		receipt: readReceipt(paths, handoffId),
	};
}
