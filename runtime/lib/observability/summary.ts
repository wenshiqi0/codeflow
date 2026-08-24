import type { HandoffStateProjection } from "./handoff-state";

export interface ObligationDistribution {
	met: number;
	exempt: number;
	missing: number;
	malformed: number;
	eligible: number;
}

export interface DecompositionDistribution {
	split: number;
	solo: number;
	missing: number;
	malformed: number;
	eligible: number;
	mismatch: number;
	actual_split: number;
}

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
	decomposition: DecompositionDistribution;
	obligations: {
		regression: ObligationDistribution;
		reproduction: ObligationDistribution;
		consumers: ObligationDistribution;
	};
}

function emptyObligationDistribution(): ObligationDistribution {
	return { met: 0, exempt: 0, missing: 0, malformed: 0, eligible: 0 };
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
		decomposition: { split: 0, solo: 0, missing: 0, malformed: 0, eligible: 0, mismatch: 0, actual_split: 0 },
		obligations: {
			regression: emptyObligationDistribution(),
			reproduction: emptyObligationDistribution(),
			consumers: emptyObligationDistribution(),
		},
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
	if (state.decomposition !== null) {
		summary.decomposition[state.decomposition]++;
		summary.decomposition.eligible++;
		if (state.decomposition_mismatch) summary.decomposition.mismatch++;
		if (state.has_direct_child) summary.decomposition.actual_split++;
	}
	for (const [name, value] of [
		["regression", state.obligation_regression],
		["reproduction", state.obligation_reproduction],
		["consumers", state.obligation_consumers],
	] as const) {
		if (value === null) continue;
		summary.obligations[name][value]++;
		summary.obligations[name].eligible++;
	}
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
