import type { AttemptUsageRecord } from "./model-usage";
import type { ToolCallRecord } from "./tool-execution";

export interface WallBreakdown {
	tool_execution_seconds: number;
	provider_wait_derived_seconds: number;
	local_overhead_derived_seconds: number;
	attribution: "derived";
	metrics_available: boolean;
}

interface Interval {
	start: number;
	end: number;
}

function mergeIntervals(values: Interval[]): Interval[] {
	const valid = values.filter((value) => value.end > value.start).sort((a, b) => a.start - b.start);
	const merged: Interval[] = [];
	for (const value of valid) {
		const last = merged[merged.length - 1];
		if (last !== undefined && value.start <= last.end) {
			last.end = Math.max(last.end, value.end);
			continue;
		}
		merged.push({ ...value });
	}
	return merged;
}

function duration(values: Interval[]): number {
	return values.reduce((sum, value) => sum + (value.end - value.start), 0);
}

function subtractIntervals(values: Interval[], remove: Interval[]): Interval[] {
	let output = [...values];
	for (const hole of mergeIntervals(remove)) {
		const next: Interval[] = [];
		for (const value of output) {
			if (hole.end <= value.start || hole.start >= value.end) {
				next.push(value);
				continue;
			}
			if (hole.start > value.start) next.push({ start: value.start, end: hole.start });
			if (hole.end < value.end) next.push({ start: hole.end, end: value.end });
		}
		output = next;
	}
	return output;
}

function clampIntervals(values: Interval[], start: number, end: number): Interval[] {
	return mergeIntervals(
		values
			.map((value) => ({ start: Math.max(value.start, start), end: Math.min(value.end, end) }))
			.filter((value) => value.end > value.start),
	);
}

function toolIntervals(records: readonly ToolCallRecord[]): Interval[] {
	const requested = new Map<string, number>();
	const intervals: Interval[] = [];
	for (const record of records) {
		const at = Date.parse(record.at);
		if (record.kind === "requested") {
			if (!requested.has(record.call_id)) requested.set(record.call_id, at);
			continue;
		}
		const start = requested.get(record.call_id);
		if (start !== undefined && at >= start) intervals.push({ start, end: at });
	}
	return mergeIntervals(intervals);
}

function providerIntervals(
	usageRecords: readonly AttemptUsageRecord[],
	toolExecution: Interval[],
): Interval[] {
	const eventTimes = [
		...usageRecords.map((record) => Date.parse(record.at)),
		...toolExecution.map((value) => value.end),
	].sort((a, b) => a - b);
	const raw = usageRecords.map((record) => {
		const end = Date.parse(record.at);
		const observedStart = record.request_started_at === null ? null : Date.parse(record.request_started_at);
		if (observedStart !== null && !Number.isNaN(observedStart) && observedStart <= end) {
			return { start: observedStart, end };
		}
		const earlier = eventTimes.filter((time) => time < end);
		const start = earlier.length > 0 ? Math.max(...earlier) : end;
		return { start, end };
	});
	return mergeIntervals(subtractIntervals(mergeIntervals(raw), toolExecution));
}

/**
 * Wall attribution is deliberately labeled derived. Tool intervals use source
 * requested/result timestamps; provider wait is the response interval outside
 * tool execution. It is suitable for before/after comparison in one environment,
 * not cross-environment ranking.
 */
export function summarizeWallBreakdown(
	usageRecords: readonly AttemptUsageRecord[],
	toolCallRecords: readonly ToolCallRecord[],
	wallSeconds: number,
	wallStartedAtMs?: number | null,
): WallBreakdown {
	const bounds =
		wallStartedAtMs === undefined || wallStartedAtMs === null || wallSeconds < 0
			? null
			: { start: wallStartedAtMs, end: wallStartedAtMs + wallSeconds * 1000 };
	let tools = toolIntervals(toolCallRecords);
	if (bounds !== null) tools = clampIntervals(tools, bounds.start, bounds.end);
	let provider = providerIntervals(usageRecords, tools);
	if (bounds !== null) provider = clampIntervals(provider, bounds.start, bounds.end);
	const toolSeconds = duration(tools) / 1000;
	const providerSeconds = duration(provider) / 1000;
	return {
		tool_execution_seconds: toolSeconds,
		provider_wait_derived_seconds: providerSeconds,
		local_overhead_derived_seconds: Math.max(0, wallSeconds - toolSeconds - providerSeconds),
		attribution: "derived",
		metrics_available: true,
	};
}
