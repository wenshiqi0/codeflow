import type { HandoffStateProjection } from "./handoff-state";

export interface HandoffObservabilitySummary {
	total: number;
	open: number;
	running: number;
	interrupted: number;
	completed: number;
	partial: number;
	blocked: number;
	failed: number;
	superseded: number;
	runtime_failure_reasons: Record<string, number>;
	unknown_runtime_failure_reasons: number;
	metrics_available: boolean;
}

export function emptyHandoffObservabilitySummary(): HandoffObservabilitySummary {
	return {
		total: 0,
		open: 0,
		running: 0,
		interrupted: 0,
		completed: 0,
		partial: 0,
		blocked: 0,
		failed: 0,
		superseded: 0,
		runtime_failure_reasons: {},
		unknown_runtime_failure_reasons: 0,
		metrics_available: false,
	};
}

export function addHandoffState(
	summary: HandoffObservabilitySummary,
	state: HandoffStateProjection,
): void {
	summary.total++;
	summary[state.status]++;
	for (const reason of state.runtime_failure_reasons) {
		summary.runtime_failure_reasons[reason] = (summary.runtime_failure_reasons[reason] ?? 0) + 1;
	}
	summary.unknown_runtime_failure_reasons += state.unknown_runtime_failure_reasons;
}

export function summarizeHandoffStates(
	states: readonly HandoffStateProjection[],
	metricsAvailable: boolean,
): HandoffObservabilitySummary {
	const summary = emptyHandoffObservabilitySummary();
	summary.metrics_available = metricsAvailable;
	for (const state of states) addHandoffState(summary, state);
	return summary;
}
