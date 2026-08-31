import {
	commitmentHistory,
	loadCommitment,
	loadReceiptChain,
	type CommitmentRecord,
	type ReceiptRecord,
} from "./commitment";
import { RunPaths } from "./paths";
import { goalState } from "./state";

export interface CommitmentSummary {
	commitment: CommitmentRecord;
	status: string;
	receipt_count: number;
	latest: ReceiptRecord | null;
}

export interface GoalInspection {
	goal: ReturnType<typeof goalState>;
	commitments: CommitmentSummary[];
}

export interface CommitmentInspection {
	commitment: CommitmentRecord;
	receipts: ReceiptRecord[];
}

export interface ReceiptInspection {
	commitment: CommitmentRecord;
	receipt: ReceiptRecord;
}

export function inspectGoal(paths: RunPaths, goalId: string): GoalInspection {
	return {
		goal: goalState(paths, goalId),
		commitments: commitmentHistory(paths)
			.filter((view) => view.commitment.goal_id === goalId)
			.map((view) => ({
				commitment: view.commitment,
				status: view.status,
				receipt_count: view.folded.receipts.length,
				latest: view.folded.head,
			})),
	};
}

export function inspectCommitment(paths: RunPaths, commitmentId: string): CommitmentInspection {
	const commitment = loadCommitment(paths, commitmentId);
	return { commitment, receipts: loadReceiptChain(paths, commitmentId).receipts };
}

export function inspectReceipt(paths: RunPaths, receiptId: string): ReceiptInspection {
	for (const view of commitmentHistory(paths)) {
		const receipt = view.folded.receipts.find((candidate) => candidate.id === receiptId);
		if (receipt) return { commitment: view.commitment, receipt };
	}
	throw new Error(`unknown Receipt: ${receiptId}`);
}
