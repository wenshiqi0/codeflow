import type { HandoffStateProjection } from "./handoff-state";

export interface HandoffObservabilitySummary {
	total: number;
	pass: number;
	fail: number;
	blocked: number;
	nonterminal: number;
	blocked_reasons: Record<string, number>;
	unknown_blocked_reasons: number;
	redelegations: number;
	metrics_available: boolean;
}

export function emptyHandoffObservabilitySummary(): HandoffObservabilitySummary {
	return {
		total: 0,
		pass: 0,
		fail: 0,
		blocked: 0,
		nonterminal: 0,
		blocked_reasons: {},
		unknown_blocked_reasons: 0,
		redelegations: 0,
		metrics_available: false,
	};
}

export function summarizeHandoffStates(
	states: readonly HandoffStateProjection[],
	metricsAvailable: boolean,
): HandoffObservabilitySummary {
	const summary = emptyHandoffObservabilitySummary();
	summary.metrics_available = metricsAvailable;
	for (const state of states) {
		summary.total++;
		if (state.status === "blocked") {
			summary.blocked++;
			for (const reason of state.blocked_reasons) {
				summary.blocked_reasons[reason] = (summary.blocked_reasons[reason] ?? 0) + 1;
			}
			summary.unknown_blocked_reasons += state.unknown_blocked_reasons;
		} else if (state.status === "done") {
			if (state.result === "PASS") summary.pass++;
			else if (state.result === "FAIL") summary.fail++;
			else summary.nonterminal++;
		} else {
			summary.nonterminal++;
		}
		if (state.retry_of !== null) summary.redelegations++;
	}
	return summary;
}
