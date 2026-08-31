/** Numeric, privacy-safe observations captured immediately before provider requests. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ContentShape, RequestPromptShape, WorkerContextShape } from "./prompt-shape";
import { RunPaths } from "../paths";

export const RUN_FACTS_SCHEMA_VERSION = 3;

export type ContextUtilization =
	| { value: number; basis: "pi_estimate" }
	| { basis: "unknown" };

export interface RunFactsRecord {
	schema_version: 3;
	task_id: string;
	execution_id: string;
	commitment_id: string | null;
	goal_id: string;
	execution_rounds_elapsed: number;
	context_utilization: ContextUtilization;
	prompt_shape: RequestPromptShape;
	prefix_transition_count: 0 | 1;
	prefix_invalidation_count: 0 | 1;
	system_prompt_changed: 0 | 1;
	tool_schema_changed: 0 | 1;
	worker_context_changed: 0 | 1;
	message_prefix_invalidated: 0 | 1;
}

export interface PrefixCacheMetrics {
	prefix_transition_count: number;
	prefix_invalidation_count: number;
	prefix_invalidation_rate: number | null;
	system_prompt_change_count: number;
	tool_schema_change_count: number;
	worker_context_change_count: number;
	message_prefix_invalidation_count: number;
	prompt_shape_metrics_available: boolean;
	component_chars: {
		system_prompt: number[];
		tool_schema: number[];
		worker_context: number[];
		message_prefix_min: number | null;
		message_prefix_max: number | null;
	};
	max_context_utilization: number | null;
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
			|| typeof value.execution_id !== "string"
			|| value.execution_id.length === 0
			|| (value.commitment_id !== null && typeof value.commitment_id !== "string")
			|| !Number.isSafeInteger(value.execution_rounds_elapsed)
			|| ![0, 1].includes(value.prefix_transition_count)
			|| ![0, 1].includes(value.prefix_invalidation_count)
			|| value.prefix_invalidation_count > value.prefix_transition_count
			|| ![0, 1].includes(value.system_prompt_changed)
			|| ![0, 1].includes(value.tool_schema_changed)
			|| ![0, 1].includes(value.worker_context_changed)
			|| ![0, 1].includes(value.message_prefix_invalidated)
			|| value.system_prompt_changed > value.prefix_transition_count
			|| value.tool_schema_changed > value.prefix_transition_count
			|| value.worker_context_changed > value.prefix_transition_count
			|| value.message_prefix_invalidated > value.prefix_transition_count
			|| !validPromptShape(value.prompt_shape)
		) throw new Error(`malformed run-facts row ${index + 1} in ${file}`);
		return value;
	});
}

function validContentShape(value: unknown): value is ContentShape {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const shape = value as Partial<ContentShape>;
	return typeof shape.hash === "string" && shape.hash.length > 0
		&& Number.isSafeInteger(shape.chars) && (shape.chars ?? -1) >= 0;
}

function validWorkerContextShape(value: unknown): value is WorkerContextShape {
	if (!validContentShape(value)) return false;
	const shape = value as WorkerContextShape;
	return Array.isArray(shape.sections) && shape.sections.every((section) =>
		validContentShape(section) && typeof section.kind === "string" && section.kind.length > 0
	);
}

function validPromptShape(value: unknown): value is RequestPromptShape {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const shape = value as RequestPromptShape;
	return validContentShape(shape.system_prompt)
		&& validContentShape(shape.tool_schema)
		&& Number.isSafeInteger(shape.tool_schema.count)
		&& shape.tool_schema.count >= 0
		&& validWorkerContextShape(shape.worker_context)
		&& validContentShape(shape.message_prefix);
}

function uniqueSorted(values: number[]): number[] {
	return [...new Set(values)].sort((left, right) => left - right);
}

export function summarizePrefixCache(records: readonly RunFactsRecord[]): PrefixCacheMetrics {
	const transitions = records.reduce((sum, record) => sum + record.prefix_transition_count, 0);
	const invalidations = records.reduce((sum, record) => sum + record.prefix_invalidation_count, 0);
	const messagePrefixChars = records.map((record) => record.prompt_shape.message_prefix.chars);
	const utilizations = records.flatMap((record) =>
		record.context_utilization.basis === "pi_estimate" ? [record.context_utilization.value] : []
	);
	return {
		prefix_transition_count: transitions,
		prefix_invalidation_count: invalidations,
		prefix_invalidation_rate: transitions > 0 ? invalidations / transitions : null,
		system_prompt_change_count: records.reduce((sum, record) => sum + record.system_prompt_changed, 0),
		tool_schema_change_count: records.reduce((sum, record) => sum + record.tool_schema_changed, 0),
		worker_context_change_count: records.reduce((sum, record) => sum + record.worker_context_changed, 0),
		message_prefix_invalidation_count: records.reduce((sum, record) => sum + record.message_prefix_invalidated, 0),
		prompt_shape_metrics_available: records.length > 0,
		component_chars: {
			system_prompt: uniqueSorted(records.map((record) => record.prompt_shape.system_prompt.chars)),
			tool_schema: uniqueSorted(records.map((record) => record.prompt_shape.tool_schema.chars)),
			worker_context: uniqueSorted(records.map((record) => record.prompt_shape.worker_context.chars)),
			message_prefix_min: messagePrefixChars.length > 0 ? Math.min(...messagePrefixChars) : null,
			message_prefix_max: messagePrefixChars.length > 0 ? Math.max(...messagePrefixChars) : null,
		},
		max_context_utilization: utilizations.length > 0 ? Math.max(...utilizations) : null,
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
