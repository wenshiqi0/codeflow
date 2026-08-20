/**
 * Event delivery.
 *
 * The outer loop watches one directory and reads nothing but file *names*.
 * That is why delivery is write-to-`tmp/` then rename: a rename is atomic
 * within a filesystem, so a listener woken by `IN_MOVED_TO` can trust that
 * what it sees is complete. A plain write would let it observe a half-written
 * file and infer a state that never existed.
 *
 * The name carries the whole metadata surface:
 *
 * ```text
 * <seq>--<subject>--<kind>--<status>.json
 * ```
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { nextSeq } from "./seq";
import { nowIso, slug } from "./paths";

export const EVENT_KINDS = [
	"run_started",
	"run_resumed",
	"run_finished",
	"handoff_opened",
	"handoff_finished",
	"artifact_written",
	"runner_exited",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_STATUSES = [
	"STARTED",
	"OPEN",
	"WRITTEN",
	"PASS",
	"FAIL",
	"BLOCKED",
	"EXITED",
] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_REASONS = [
	"CONTEXT_BUDGET_EXCEEDED",
	"DELEGATION_ARTIFACT_MISSING",
	"EXECUTION_TIMEOUT",
	"OUTPUT_TRUNCATED",
	"PROVIDER_FAILURE",
	"USER_CANCELLED",
] as const;

export type EventReason = (typeof EVENT_REASONS)[number];

export const MAX_EVENT_SUMMARY_CHARS = 240;
export const MAX_EVENT_LOG_SIDE_CHARS = 100;

/**
 * The event body is deliberately not an arbitrary object. Besides the
 * contract fields written by deliverEvent, payloads may carry only identifiers
 * and pointers. Diagnostics and provider prose have no legal route into events.
 */
const ALLOWED_PAYLOAD_KEYS = new Set([
	"reasons",
	"summary",
	"ref",
	"refs",
	"receipt_ref",
	"handoff_id",
	"role",
	"depth",
	"goal_id",
	"lane",
	"pid",
	"run_id",
]);

/** An event summary is one bounded mechanical line. */
export function eventSummary(value: unknown): string {
	const text = String(value ?? "")
	.replace(/[\r\n]+/g, " ")
	.replace(/\s+/g, " ")
	.trim();
	const chars = Array.from(text);
	if (chars.length <= MAX_EVENT_SUMMARY_CHARS) return text;
	return chars.slice(0, MAX_EVENT_SUMMARY_CHARS - 1).join("").trimEnd() + "…";
}

function redactSecrets(value: string): string {
	return value
		.replace(
			/\b(api[_-]?key|authorization|password|secret|token)\b\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/:-]+/gi,
			(match, label: string) => `${label}=[REDACTED]`,
		)
		.replace(
			/\b(api[_-]?key|authorization|bearer|password|secret|token)\b\s*[:=]\s*[^\s,;]+/gi,
			(match, label: string) => `${label}=[REDACTED]`,
		)
		.replace(/\bBearer\s+[A-Za-z0-9._~+/:-]+/gi, "Bearer [REDACTED]");
}

/**
 * Fallback summary for a missing summary or a terminal error: preserve the
 * beginning and end of the original log, 100 characters each, on one line.
 * Obvious credentials are redacted before the excerpt crosses the event plane.
 */
export function eventLogExcerpt(value: unknown): string {
	const text = redactSecrets(
		String(value ?? "")
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim(),
	);
	if (!text) return "";
	const chars = Array.from(text);
	if (chars.length <= MAX_EVENT_LOG_SIDE_CHARS * 2) return eventSummary(text);
	const head = chars.slice(0, MAX_EVENT_LOG_SIDE_CHARS).join("").trimEnd();
	const tail = chars.slice(-MAX_EVENT_LOG_SIDE_CHARS).join("").trimStart();
	return eventSummary(`${head} ... ${tail}`);
}

/** Keep event names inside the 255-byte limit every target filesystem has. */
const MAX_NAME_BYTES = 255;
export const MAX_SUBJECT_CHARS = 120;

export interface DeliveredEvent {
	seq: number;
	file: string;
}

export function eventName(seq: number, subject: string, kind: string, status: string): string {
	let cleaned = slug(subject).slice(0, MAX_SUBJECT_CHARS);
	let name = `${String(seq).padStart(5, "0")}--${cleaned}--${kind}--${status}.json`;
	const overflow = Buffer.byteLength(name, "utf-8") - MAX_NAME_BYTES;
	if (overflow > 0) {
		cleaned = cleaned.slice(0, Math.max(1, cleaned.length - overflow));
		name = `${String(seq).padStart(5, "0")}--${cleaned}--${kind}--${status}.json`;
	}
	return name;
}

/**
 * Stage a file, then rename it into the watched directory.
 *
 * Sequence allocation happens before the write so the number is claimed even
 * if the body fails to serialize; a gap is harmless, a duplicate is not.
 */
export function deliverEvent(options: {
	stagingDir: string;
	targetDir: string;
	counterPath: string;
	subject: string;
	kind: string;
	status: string;
	payload: Record<string, unknown>;
}): DeliveredEvent {
	if (!(EVENT_KINDS as readonly string[]).includes(options.kind)) {
		throw new Error(`unknown event kind: ${options.kind}`);
	}
	if (!(EVENT_STATUSES as readonly string[]).includes(options.status)) {
		throw new Error(`unknown event status: ${options.status}`);
	}
	for (const key of Object.keys(options.payload)) {
		if (!ALLOWED_PAYLOAD_KEYS.has(key)) {
			throw new Error(`event payload field is not allowed: ${key}`);
		}
	}
	const reasons = options.payload.reasons;
	if (reasons !== undefined) {
		if (!Array.isArray(reasons)) throw new Error("event reasons must be an array");
		for (const reason of reasons) {
			if (!(EVENT_REASONS as readonly string[]).includes(reason)) {
				throw new Error(`unknown event reason: ${reason}`);
			}
		}
	}
	fs.mkdirSync(options.stagingDir, { recursive: true });
	fs.mkdirSync(options.targetDir, { recursive: true });

	const seq = nextSeq(options.counterPath);
	const name = eventName(seq, options.subject, options.kind, options.status);
	const body = {
		...options.payload,
		schema_version: 1,
		seq,
		kind: options.kind,
		status: options.status,
		subject: slug(options.subject).slice(0, MAX_SUBJECT_CHARS),
		at: nowIso(),
		summary: eventSummary(options.payload.summary ?? `${options.kind} ${options.status}`),
	};

	const staging = path.join(options.stagingDir, name);
	fs.writeFileSync(staging, JSON.stringify(body) + "\n", "utf-8");
	fs.renameSync(staging, path.join(options.targetDir, name));
	return { seq, file: name };
}
