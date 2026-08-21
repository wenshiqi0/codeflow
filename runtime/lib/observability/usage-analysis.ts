import type { AttemptUsageRecord } from "./model-usage";
import type { HandoffStateProjection } from "./handoff-state";

export interface WasteSummary {
	rounds_in_non_pass_handoffs: number | null;
	tokens_in_non_pass_handoffs: number | null;
	waste_ratio_rounds: number | null;
	planner_rounds_ratio: number | null;
	handoff_reopens_per_goal_lane_median: number | null;
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
	if (!telemetryAvailable) {
		return {
			rounds_in_non_pass_handoffs: null,
			tokens_in_non_pass_handoffs: null,
			waste_ratio_rounds: null,
			planner_rounds_ratio: null,
			handoff_reopens_per_goal_lane_median: null,
			metrics_available: false,
		};
	}
	const byHandoff = new Map(handoffs.map((state) => [state.handoff_id, state]));
	const allUsageHandoffsKnown = usageRecords.every(
		(record) => record.handoff_id === null || byHandoff.has(record.handoff_id),
	);
	if (!allUsageHandoffsKnown) {
		return {
			rounds_in_non_pass_handoffs: null,
			tokens_in_non_pass_handoffs: null,
			waste_ratio_rounds: null,
			planner_rounds_ratio: null,
			handoff_reopens_per_goal_lane_median: null,
			metrics_available: false,
		};
	}
	let nonPassRounds = 0;
	let nonPassTokens = 0;
	let depthKnownRounds = 0;
	let depthZeroRounds = 0;
	for (const record of usageRecords) {
		if (record.depth !== null) {
			depthKnownRounds++;
			if (record.depth === 0) depthZeroRounds++;
		}
		if (record.handoff_id !== null) {
			const state = byHandoff.get(record.handoff_id);
			if (state !== undefined && state.result !== "PASS") {
				nonPassRounds++;
				nonPassTokens += record.usage.total_tokens;
			}
		}
	}
	const groups = new Map<string, number>();
	for (const state of handoffs) {
		if (state.goal_id === null || state.lane === null) continue;
		const key = `${state.goal_id}\0${state.lane}`;
		groups.set(key, (groups.get(key) ?? 0) + 1);
	}
	return {
		rounds_in_non_pass_handoffs: nonPassRounds,
		tokens_in_non_pass_handoffs: nonPassTokens,
		waste_ratio_rounds: usageRecords.length > 0 ? nonPassRounds / usageRecords.length : null,
		planner_rounds_ratio: depthKnownRounds > 0 ? depthZeroRounds / depthKnownRounds : null,
		handoff_reopens_per_goal_lane_median: median([...groups.values()].map((count) => count - 1)),
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
		const list = byHandoff.get(record.handoff_id) ?? [];
		list.push(record);
		byHandoff.set(record.handoff_id, list);
	}
	const knownHandoffs = new Set(handoffs.map((state) => state.handoff_id));
	if ([...byHandoff.keys()].some((handoffId) => !knownHandoffs.has(handoffId))) {
		return { first_turn_input_by_handoff_index: null, metrics_available: false };
	}
	const groups = new Map<string, number[]>();
	let available = true;
	for (const state of handoffs) {
		if (state.goal_id === null || state.lane === null) continue;
		const records = byHandoff.get(state.handoff_id) ?? [];
		if (records.length === 0) continue;
		const first = [...records].sort((a, b) => (a.turn ?? Infinity) - (b.turn ?? Infinity))[0];
		if (first.turn === null || first.usage.cache_read === null) {
			available = false;
			continue;
		}
		const key = `${state.goal_id}\0${state.lane}`;
		const list = groups.get(key) ?? [];
		list.push(first.usage.input + first.usage.cache_read);
		groups.set(key, list);
	}
	if (!available || groups.size === 0) {
		return { first_turn_input_by_handoff_index: null, metrics_available: false };
	}
	const maxLength = Math.max(...[...groups.values()].map((values) => values.length));
	const sequence: number[] = [];
	for (let index = 0; index < maxLength; index++) {
		const values = [...groups.values()].map((entries) => entries[index]).filter((value) => value !== undefined);
		const value = median(values);
		if (value === null) {
			return { first_turn_input_by_handoff_index: null, metrics_available: false };
		}
		sequence.push(value);
	}
	return { first_turn_input_by_handoff_index: sequence, metrics_available: true };
}
