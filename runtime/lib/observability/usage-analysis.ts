import type { AttemptUsageRecord } from "./model-usage";
import type { CommitmentStateProjection } from "./commitment-state";

export interface WasteSummary {
	rounds_in_non_completed_commitments: number | null;
	tokens_in_non_completed_commitments: number | null;
	non_completed_round_ratio: number | null;
	worker_rounds_ratio: number | null;
	commitments_per_goal_median: number | null;
	metrics_available: boolean;
}

export interface ContextGrowthSummary {
	first_turn_input_by_commitment_index: number[] | null;
	metrics_available: boolean;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarizeWaste(
	usageRecords: readonly AttemptUsageRecord[],
	commitments: readonly CommitmentStateProjection[],
	telemetryAvailable: boolean,
): WasteSummary {
	const unavailable: WasteSummary = {
		rounds_in_non_completed_commitments: null,
		tokens_in_non_completed_commitments: null,
		non_completed_round_ratio: null,
		worker_rounds_ratio: null,
		commitments_per_goal_median: null,
		metrics_available: false,
	};
	if (!telemetryAvailable) return unavailable;
	const byCommitment = new Map(commitments.map((state) => [state.commitment_id, state]));
	if (usageRecords.some((record) => record.commitment_id !== null && !byCommitment.has(record.commitment_id))) {
		return unavailable;
	}
	let nonCompletedRounds = 0;
	let nonCompletedTokens = 0;
	let workerRounds = 0;
	for (const record of usageRecords) {
		if (record.worker_kind === "worker") workerRounds++;
		const state = record.commitment_id === null ? undefined : byCommitment.get(record.commitment_id);
		if (state && state.status !== "completed") {
			nonCompletedRounds++;
			nonCompletedTokens += record.usage.total_tokens;
		}
	}
	const byGoal = new Map<string, number>();
	for (const state of commitments) byGoal.set(state.goal_id, (byGoal.get(state.goal_id) ?? 0) + 1);
	return {
		rounds_in_non_completed_commitments: nonCompletedRounds,
		tokens_in_non_completed_commitments: nonCompletedTokens,
		non_completed_round_ratio: usageRecords.length > 0 ? nonCompletedRounds / usageRecords.length : null,
		worker_rounds_ratio: usageRecords.length > 0 ? workerRounds / usageRecords.length : null,
		commitments_per_goal_median: median([...byGoal.values()]),
		metrics_available: true,
	};
}

export function summarizeContextGrowth(
	usageRecords: readonly AttemptUsageRecord[],
	commitments: readonly CommitmentStateProjection[],
	telemetryAvailable: boolean,
): ContextGrowthSummary {
	if (!telemetryAvailable || commitments.length === 0) {
		return { first_turn_input_by_commitment_index: null, metrics_available: false };
	}
	const byCommitment = new Map<string, AttemptUsageRecord[]>();
	for (const record of usageRecords) {
		if (record.commitment_id === null) continue;
		const entries = byCommitment.get(record.commitment_id) ?? [];
		entries.push(record);
		byCommitment.set(record.commitment_id, entries);
	}
	if ([...byCommitment.keys()].some((id) => !commitments.some((state) => state.commitment_id === id))) {
		return { first_turn_input_by_commitment_index: null, metrics_available: false };
	}
	const byGoal = new Map<string, number[]>();
	for (const state of commitments) {
		const records = byCommitment.get(state.commitment_id) ?? [];
		if (records.length === 0) continue;
		const first = [...records].sort((a, b) => (a.turn ?? Infinity) - (b.turn ?? Infinity))[0];
		if (first.turn === null || first.usage.cache_read === null) {
			return { first_turn_input_by_commitment_index: null, metrics_available: false };
		}
		const values = byGoal.get(state.goal_id) ?? [];
		values.push(first.usage.input + first.usage.cache_read);
		byGoal.set(state.goal_id, values);
	}
	if (byGoal.size === 0) return { first_turn_input_by_commitment_index: null, metrics_available: false };
	const max = Math.max(...[...byGoal.values()].map((values) => values.length));
	const sequence: number[] = [];
	for (let index = 0; index < max; index++) {
		const value = median([...byGoal.values()].flatMap((values) => values[index] === undefined ? [] : [values[index]]));
		if (value === null) return { first_turn_input_by_commitment_index: null, metrics_available: false };
		sequence.push(value);
	}
	return { first_turn_input_by_commitment_index: sequence, metrics_available: true };
}
