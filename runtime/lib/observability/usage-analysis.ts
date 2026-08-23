import type { AttemptUsageRecord } from "./model-usage";
import type { HandoffStateProjection } from "./handoff-state";

export interface WasteSummary {
	rounds_in_non_completed_handoffs: number | null;
	tokens_in_non_completed_handoffs: number | null;
	non_completed_round_ratio: number | null;
	worker_rounds_ratio: number | null;
	handoffs_per_goal_median: number | null;
	metrics_available: boolean;
}

export interface ContextGrowthSummary {
	first_turn_input_by_handoff_index: number[] | null;
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
	handoffs: readonly HandoffStateProjection[],
	telemetryAvailable: boolean,
): WasteSummary {
	const unavailable: WasteSummary = {
		rounds_in_non_completed_handoffs: null,
		tokens_in_non_completed_handoffs: null,
		non_completed_round_ratio: null,
		worker_rounds_ratio: null,
		handoffs_per_goal_median: null,
		metrics_available: false,
	};
	if (!telemetryAvailable) return unavailable;
	const byHandoff = new Map(handoffs.map((state) => [state.handoff_id, state]));
	if (usageRecords.some((record) => record.handoff_id !== null && !byHandoff.has(record.handoff_id))) {
		return unavailable;
	}
	let nonCompletedRounds = 0;
	let nonCompletedTokens = 0;
	let workerRounds = 0;
	for (const record of usageRecords) {
		if (record.worker_kind === "worker") workerRounds++;
		const state = record.handoff_id === null ? undefined : byHandoff.get(record.handoff_id);
		if (state && state.status !== "completed") {
			nonCompletedRounds++;
			nonCompletedTokens += record.usage.total_tokens;
		}
	}
	const byGoal = new Map<string, number>();
	for (const state of handoffs) byGoal.set(state.goal_id, (byGoal.get(state.goal_id) ?? 0) + 1);
	return {
		rounds_in_non_completed_handoffs: nonCompletedRounds,
		tokens_in_non_completed_handoffs: nonCompletedTokens,
		non_completed_round_ratio: usageRecords.length > 0 ? nonCompletedRounds / usageRecords.length : null,
		worker_rounds_ratio: usageRecords.length > 0 ? workerRounds / usageRecords.length : null,
		handoffs_per_goal_median: median([...byGoal.values()]),
		metrics_available: true,
	};
}

export function summarizeContextGrowth(
	usageRecords: readonly AttemptUsageRecord[],
	handoffs: readonly HandoffStateProjection[],
	telemetryAvailable: boolean,
): ContextGrowthSummary {
	if (!telemetryAvailable || handoffs.length === 0) {
		return { first_turn_input_by_handoff_index: null, metrics_available: false };
	}
	const byHandoff = new Map<string, AttemptUsageRecord[]>();
	for (const record of usageRecords) {
		if (record.handoff_id === null) continue;
		const entries = byHandoff.get(record.handoff_id) ?? [];
		entries.push(record);
		byHandoff.set(record.handoff_id, entries);
	}
	if ([...byHandoff.keys()].some((id) => !handoffs.some((state) => state.handoff_id === id))) {
		return { first_turn_input_by_handoff_index: null, metrics_available: false };
	}
	const byGoal = new Map<string, number[]>();
	for (const state of handoffs) {
		const records = byHandoff.get(state.handoff_id) ?? [];
		if (records.length === 0) continue;
		const first = [...records].sort((a, b) => (a.turn ?? Infinity) - (b.turn ?? Infinity))[0];
		if (first.turn === null || first.usage.cache_read === null) {
			return { first_turn_input_by_handoff_index: null, metrics_available: false };
		}
		const values = byGoal.get(state.goal_id) ?? [];
		values.push(first.usage.input + first.usage.cache_read);
		byGoal.set(state.goal_id, values);
	}
	if (byGoal.size === 0) return { first_turn_input_by_handoff_index: null, metrics_available: false };
	const max = Math.max(...[...byGoal.values()].map((values) => values.length));
	const sequence: number[] = [];
	for (let index = 0; index < max; index++) {
		const value = median([...byGoal.values()].flatMap((values) => values[index] === undefined ? [] : [values[index]]));
		if (value === null) return { first_turn_input_by_handoff_index: null, metrics_available: false };
		sequence.push(value);
	}
	return { first_turn_input_by_handoff_index: sequence, metrics_available: true };
}
