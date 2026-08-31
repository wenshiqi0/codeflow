import type { CommitmentStateProjection } from "./commitment-state";

export interface CommitmentObservabilitySummary {
	total: number;
	open: number;
	running: number;
	interrupted: number;
	completed: number;
	blocked: number;
	delegating: number;
	runtime_failure_reasons: Record<string, number>;
	unknown_runtime_failure_reasons: number;
	metrics_available: boolean;
}

export function emptyCommitmentObservabilitySummary(): CommitmentObservabilitySummary {
	return {
		total: 0,
		open: 0,
		running: 0,
		interrupted: 0,
		completed: 0,
		blocked: 0,
		delegating: 0,
		runtime_failure_reasons: {},
		unknown_runtime_failure_reasons: 0,
		metrics_available: false,
	};
}

export function addCommitmentState(
	summary: CommitmentObservabilitySummary,
	state: CommitmentStateProjection,
): void {
	summary.total++;
	summary[state.status]++;
	if (state.has_direct_child) summary.delegating++;
	for (const reason of state.runtime_failure_reasons) {
		summary.runtime_failure_reasons[reason] = (summary.runtime_failure_reasons[reason] ?? 0) + 1;
	}
	summary.unknown_runtime_failure_reasons += state.unknown_runtime_failure_reasons;
}

export function summarizeCommitmentStates(
	states: readonly CommitmentStateProjection[],
	metricsAvailable: boolean,
): CommitmentObservabilitySummary {
	const summary = emptyCommitmentObservabilitySummary();
	summary.metrics_available = metricsAvailable;
	for (const state of states) addCommitmentState(summary, state);
	return summary;
}
