/** Numeric, privacy-safe observations captured immediately before provider requests. */

import * as fs from "node:fs";
import * as path from "node:path";
import { RunPaths } from "../paths";

export const RUN_FACTS_SCHEMA_VERSION = 1;

export type ContextUtilization =
	| { value: number; basis: "pi_estimate" }
	| { basis: "unknown" };

export interface RunFactsRecord {
	schema_version: 1;
	task_id: string;
	handoff_id: string;
	goal_id: string;
	execution_rounds_elapsed: number;
	context_utilization: ContextUtilization;
	prefix_transition_count: 0 | 1;
	prefix_invalidation_count: 0 | 1;
}

export interface PrefixCacheMetrics {
	prefix_transition_count: number;
	prefix_invalidation_count: number;
	prefix_invalidation_rate: number | null;
	metrics_available: boolean;
}

export function appendRunFactsRecord(paths: RunPaths, record: RunFactsRecord): void {
	fs.mkdirSync(paths.runDir, { recursive: true });
	fs.appendFileSync(paths.runFactsLedger, `${JSON.stringify(record)}\n`, "utf8");
}

export function readRunFactsRecords(file: string): RunFactsRecord[] {
	let content: string;
	try {
		content = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return content.split("\n").filter((line) => line.trim()).map((line, index) => {
		const value = JSON.parse(line) as RunFactsRecord;
		if (
			value.schema_version !== RUN_FACTS_SCHEMA_VERSION
			|| !Number.isSafeInteger(value.execution_rounds_elapsed)
			|| ![0, 1].includes(value.prefix_transition_count)
			|| ![0, 1].includes(value.prefix_invalidation_count)
			|| value.prefix_invalidation_count > value.prefix_transition_count
		) throw new Error(`malformed run-facts row ${index + 1} in ${file}`);
		return value;
	});
}

export function summarizePrefixCache(records: readonly RunFactsRecord[]): PrefixCacheMetrics {
	const transitions = records.reduce((sum, record) => sum + record.prefix_transition_count, 0);
	const invalidations = records.reduce((sum, record) => sum + record.prefix_invalidation_count, 0);
	return {
		prefix_transition_count: transitions,
		prefix_invalidation_count: invalidations,
		prefix_invalidation_rate: transitions > 0 ? invalidations / transitions : null,
		metrics_available: records.length > 0,
	};
}

export function scanRunFacts(runsRoot: string): RunFactsRecord[] {
	if (!fs.existsSync(runsRoot)) return [];
	return fs.readdirSync(runsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
		.sort((left, right) => left.name.localeCompare(right.name))
		.flatMap((entry) => readRunFactsRecords(new RunPaths(runsRoot, entry.name).runFactsLedger));
}
