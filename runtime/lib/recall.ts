import { canonicalJson } from "./canonical";
import { handoffHistory, type HandoffRecord, type ReceiptRecord } from "./handoff";
import { RunPaths } from "./paths";
import { goalState } from "./state";

export const RECALL_LEVELS = ["state", "semantic", "full"] as const;
export type RecallLevel = (typeof RECALL_LEVELS)[number];

export interface SemanticHistoryEntry {
	kind: "handoff" | "receipt";
	seq: number;
	id: string;
	handoff_id?: string;
	digest?: string;
	status?: string;
	established?: string[];
	decisions?: string[];
	discovered?: string[];
	unresolved?: string[];
	blockers?: string[];
}

export type RecallResult =
	| { level: "state"; goal_id: string; state: ReturnType<typeof goalState> }
	| { level: "semantic"; goal_id: string; history: SemanticHistoryEntry[] }
	| { level: "full"; goal_id: string; history: Array<{ handoff: HandoffRecord; receipt: ReceiptRecord | null }> };

export function recallGoal(paths: RunPaths, goalId: string, level: RecallLevel): RecallResult {
	if (!(RECALL_LEVELS as readonly string[]).includes(level)) throw new Error(`unknown recall level: ${level}`);
	if (level === "state") return { level, goal_id: goalId, state: goalState(paths, goalId) };
	const history = handoffHistory(paths).filter((view) => view.handoff.goal_id === goalId);
	if (level === "full") {
		return {
			level,
			goal_id: goalId,
			history: history.map((view) => ({ handoff: view.handoff, receipt: view.receipt })),
		};
	}
	return {
		level,
		goal_id: goalId,
		history: history.flatMap((view): SemanticHistoryEntry[] => [
			{ kind: "handoff", seq: view.handoff.seq, id: view.handoff.id, digest: view.handoff.digest },
			...(view.receipt ? [{
				kind: "receipt" as const,
				seq: view.receipt.seq,
				id: view.receipt.id,
				handoff_id: view.handoff.id,
				status: view.receipt.status,
				established: view.receipt.established,
				decisions: view.receipt.decisions,
				discovered: view.receipt.discovered,
				unresolved: view.receipt.unresolved,
				blockers: view.receipt.blockers,
			}] : []),
		]).sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id)),
	};
}

/** Stable bytes suitable for the append-only prefix of a worker context. */
export function serializeRecall(result: RecallResult): string {
	return canonicalJson(result);
}
