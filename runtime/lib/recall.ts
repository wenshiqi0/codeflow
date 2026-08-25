import { canonicalJson } from "./canonical";
import {
	foldReceipts,
	handoffHistory,
	isTerminalStatus,
	loadHandoff,
	loadReceiptChain,
	type FoldedFacts,
	type HandoffRecord,
	type ReceiptRecord,
} from "./handoff";
import { RunPaths } from "./paths";
import { goalState } from "./state";

export const RECALL_LEVELS = ["state", "semantic", "full"] as const;
export type RecallLevel = (typeof RECALL_LEVELS)[number];

export type RecallResult =
	| { level: "state"; goal_id: string; state: ReturnType<typeof goalState> }
	| {
		level: "semantic";
		goal_id: string;
		state: ReturnType<typeof goalState>;
		latest: HandoffSemantic | null;
	}
	| { level: "full"; goal_id: string; history: Array<{ handoff: HandoffRecord; receipts: ReceiptRecord[] }> };

/** Receipt head metadata: enough to continue without the whole chain. */
export interface ReceiptHead {
	receipt_id: string | null;
	seq: number | null;
	status: string | null;
	terminal: boolean;
	receipt_count: number;
}

export function receiptHead(receipts: readonly ReceiptRecord[]): ReceiptHead {
	const head = receipts.at(-1) ?? null;
	return {
		receipt_id: head?.id ?? null,
		seq: head?.seq ?? null,
		status: head?.status ?? null,
		terminal: receipts.some((receipt) => isTerminalStatus(receipt.status)),
		receipt_count: receipts.length,
	};
}

export interface HandoffSemantic {
	handoff: HandoffRecord;
	head: ReceiptHead;
	folded: FoldedFacts;
}

function handoffSemantic(handoff: HandoffRecord, receipts: readonly ReceiptRecord[]): HandoffSemantic {
	return {
		handoff,
		head: receiptHead(receipts),
		folded: foldReceipts(receipts),
	};
}

export function recallGoal(paths: RunPaths, goalId: string, level: RecallLevel): RecallResult {
	if (!(RECALL_LEVELS as readonly string[]).includes(level)) throw new Error(`unknown recall level: ${level}`);
	if (level === "state") return { level, goal_id: goalId, state: goalState(paths, goalId) };
	const history = handoffHistory(paths).filter((view) => view.handoff.goal_id === goalId);
	if (level === "full") {
		return {
			level,
			goal_id: goalId,
			history: history.map((view) => ({ handoff: view.handoff, receipts: view.folded.receipts })),
		};
	}
	const latest = history
		.map((view) => ({ view, seq: view.folded.head?.seq ?? view.handoff.seq }))
		.sort((left, right) => left.seq - right.seq || left.view.handoff.id.localeCompare(right.view.handoff.id))
		.at(-1)?.view ?? null;
	return {
		level,
		goal_id: goalId,
		state: goalState(paths, goalId),
		latest: latest ? handoffSemantic(latest.handoff, latest.folded.receipts) : null,
	};
}

export type RecallHandoffResult =
	| { level: "state"; goal_id: string; handoff_id: string; head: ReceiptHead }
	| ({ level: "semantic"; goal_id: string } & HandoffSemantic)
	| ({ level: "full"; goal_id: string; receipts: ReceiptRecord[] } & HandoffSemantic);

/** Recall one Handoff by id; only `full` returns the append-only Receipt chain. */
export function recallHandoff(paths: RunPaths, handoffId: string, level: RecallLevel): RecallHandoffResult {
	if (!(RECALL_LEVELS as readonly string[]).includes(level)) throw new Error(`unknown recall level: ${level}`);
	const handoff = loadHandoff(paths, handoffId);
	const folded = loadReceiptChain(paths, handoffId);
	const head = receiptHead(folded.receipts);
	if (level === "state") return { level, goal_id: handoff.goal_id, handoff_id: handoff.id, head };
	const semantic = handoffSemantic(handoff, folded.receipts);
	if (level === "semantic") return { level, goal_id: handoff.goal_id, ...semantic };
	return { level, goal_id: handoff.goal_id, ...semantic, receipts: folded.receipts };
}

/** Recall one exact Receipt by content id, optionally bounded to one Handoff. */
export function recallReceipt(paths: RunPaths, receiptId: string, handoffId?: string): ReceiptRecord | null {
	const handoffs = handoffId
		? [loadHandoff(paths, handoffId)]
		: handoffHistory(paths).map((view) => view.handoff);
	for (const handoff of handoffs) {
		const receipt = loadReceiptChain(paths, handoff.id).receipts.find((candidate) => candidate.id === receiptId);
		if (receipt) return receipt;
	}
	return null;
}

/** Stable bytes suitable for the append-only prefix of a worker context. */
export function serializeRecall(result: RecallResult): string {
	return canonicalJson(result);
}
