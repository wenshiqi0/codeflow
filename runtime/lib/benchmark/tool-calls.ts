/**
 * Privacy-safe tool-call ledger (design §7).
 *
 * A ledger row may carry ONLY the call id, tool name, status, timestamp, and
 * Codeflow attribution fields — role AND provider/model plus goal/lane —
 * sourced from the context that EMITTED the call (the assistant response,
 * the same attribution the usage ledger records). Direct provider/model on
 * every row is what lets reports count tools by model without role→model
 * inference. No arguments, command text, tool results, source, or
 * credentials can be represented — the write path refuses any other key,
 * so a future field cannot smuggle a payload in.
 *
 * Counting: dedup by `call_id` within an attempt; a retry is a new id and
 * therefore a new call; a multi-command bash call is exactly one row pair
 * (the ledger has no field that could carry command text, so no sub-call
 * count can exist); rejected, errored, and incomplete calls still count.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const TOOL_CALL_SCHEMA_VERSION = 1;

/** The only top-level keys a ledger row may carry. */
export const TOOL_CALL_RECORD_FIELDS: readonly string[] = [
	"schema_version",
	"kind",
	"call_id",
	"tool",
	"status",
	"at",
	"run_id",
	"role",
	"depth",
	"handoff_id",
	"goal_id",
	"lane",
	"provider",
	"model",
];

export type ToolCallRecordKind = "requested" | "result";
export type ToolCallTerminalStatus = "succeeded" | "failed" | "rejected";

export interface ToolCallRecord {
	schema_version: 1;
	/** "result" rows carry the terminal status. */
	kind: ToolCallRecordKind;
	/** Dedup/association key. */
	call_id: string;
	/** Tool name only, e.g. "bash". */
	tool: string;
	/** Null exactly when kind === "requested". */
	status: ToolCallTerminalStatus | null;
	/** ISO timestamp. */
	at: string;
	run_id: string | null;
	role: string;
	depth: number;
	handoff_id: string | null;
	goal_id: string | null;
	lane: string | null;
	/** Provider of the assistant response that emitted the call — never inferred from the role. */
	provider: string;
	/** Model of the assistant response that emitted the call — never inferred from the role. */
	model: string;
}

const ALLOWED_KEYS = new Set<string>(TOOL_CALL_RECORD_FIELDS);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "rejected"]);
const NULLABLE_STRINGS = ["handoff_id", "goal_id", "lane"] as const;

/** Violation messages; an empty array means the record is privacy-safe and well-formed. */
export function validateToolCallRecord(record: unknown): string[] {
	const violations: string[] = [];
	if (typeof record !== "object" || record === null || Array.isArray(record)) {
		return ["record must be a JSON object"];
	}
	const row = record as Record<string, unknown>;

	for (const key of Object.keys(row)) {
		if (!ALLOWED_KEYS.has(key)) {
			violations.push(
				`unexpected key: ${key} (ledger rows carry id/name/status/timestamps/attribution only)`,
			);
		}
	}
	if (row.schema_version !== TOOL_CALL_SCHEMA_VERSION) {
		violations.push(`schema_version must be ${TOOL_CALL_SCHEMA_VERSION}`);
	}
	if (row.kind !== "requested" && row.kind !== "result") {
		violations.push("kind must be 'requested' or 'result'");
	}
	if (typeof row.call_id !== "string" || row.call_id.length === 0) {
		violations.push("call_id must be a non-empty string");
	}
	if (typeof row.tool !== "string" || row.tool.length === 0) {
		violations.push("tool must be a non-empty tool name");
	}
	if (row.kind === "requested") {
		if (row.status !== null) violations.push("status must be null for a requested row");
	} else if (typeof row.status !== "string" || !TERMINAL_STATUSES.has(row.status)) {
		violations.push("status must be one of succeeded|failed|rejected for a result row");
	}
	if (typeof row.at !== "string" || Number.isNaN(Date.parse(row.at))) {
		violations.push("at must be an ISO timestamp string");
	}
	if (row.run_id !== null && typeof row.run_id !== "string") {
		violations.push("run_id must be a string or null");
	}
	if (typeof row.role !== "string") {
		violations.push("role must be a string");
	}
	if (typeof row.depth !== "number" || !Number.isInteger(row.depth) || row.depth < 0) {
		violations.push("depth must be a non-negative integer");
	}
	for (const key of NULLABLE_STRINGS) {
		if (row[key] !== null && typeof row[key] !== "string") {
			violations.push(`${key} must be a string or null`);
		}
	}
	// Direct attribution is mandatory: a row without provider/model cannot be
	// counted by model, and back-filling it later would be role→model inference.
	if (typeof row.provider !== "string" || row.provider.length === 0) {
		violations.push("provider must be a non-empty string (the emitting context's provider)");
	}
	if (typeof row.model !== "string" || row.model.length === 0) {
		violations.push("model must be a non-empty string (the emitting context's model)");
	}
	return violations;
}

/** Appends one complete JSON line; throws on validation violations so nothing lands on disk. */
export function appendToolCallRecord(file: string, record: ToolCallRecord): void {
	const violations = validateToolCallRecord(record);
	if (violations.length > 0) {
		throw new Error(`refusing tool-call ledger row: ${violations.join("; ")}`);
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

/** Reads the ledger; missing file is an empty ledger, malformed lines throw loudly. */
export function readToolCallRecords(file: string): ToolCallRecord[] {
	let content: string;
	try {
		content = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const records: ToolCallRecord[] = [];
	const lines = content.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line.trim().length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			throw new Error(
				`tool-call ledger has a malformed line ${index + 1} in ${file}: ${(error as Error).message}`,
			);
		}
		const violations = validateToolCallRecord(parsed);
		if (violations.length > 0) {
			throw new Error(`tool-call ledger line ${index + 1} in ${file}: ${violations.join("; ")}`);
		}
		records.push(parsed as ToolCallRecord);
	}
	return records;
}

export interface ToolCallSummary {
	/** Unique call ids — equals requested. */
	total: number;
	requested: number;
	/** succeeded + failed + rejected. */
	completed: number;
	succeeded: number;
	failed: number;
	rejected: number;
	/** Requested, no terminal result before process end. */
	incomplete: number;
	by_tool: Record<string, number>;
}

/**
 * Summarize ledger rows: dedup by call id, classify terminal statuses,
 * `requested === completed + incomplete` holds by construction (every
 * unique id is one requested call that either received a terminal result or
 * did not).
 */
export function summarizeToolCalls(records: ToolCallRecord[]): ToolCallSummary {
	const byId = new Map<string, { tool: string; terminal: string | null }>();
	for (const record of records) {
		const existing = byId.get(record.call_id);
		if (existing === undefined) {
			byId.set(record.call_id, {
				tool: record.tool,
				terminal: record.kind === "result" ? record.status : null,
			});
			continue;
		}
		if (record.kind === "result" && record.status !== null) existing.terminal = record.status;
	}

	const summary: ToolCallSummary = {
		total: byId.size,
		requested: byId.size,
		completed: 0,
		succeeded: 0,
		failed: 0,
		rejected: 0,
		incomplete: 0,
		by_tool: {},
	};
	for (const call of byId.values()) {
		summary.by_tool[call.tool] = (summary.by_tool[call.tool] ?? 0) + 1;
		switch (call.terminal) {
			case "succeeded":
				summary.succeeded++;
				summary.completed++;
				break;
			case "failed":
				summary.failed++;
				summary.completed++;
				break;
			case "rejected":
				summary.rejected++;
				summary.completed++;
				break;
			default:
				summary.incomplete++;
		}
	}
	return summary;
}
