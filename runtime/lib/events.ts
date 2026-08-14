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
	"run_finished",
	"handoff_opened",
	"handoff_finished",
	"artifact_written",
	"runner_exited",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

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
	fs.mkdirSync(options.stagingDir, { recursive: true });
	fs.mkdirSync(options.targetDir, { recursive: true });

	const seq = nextSeq(options.counterPath);
	const name = eventName(seq, options.subject, options.kind, options.status);
	const body = {
		schema_version: 1,
		seq,
		kind: options.kind,
		status: options.status,
		subject: slug(options.subject).slice(0, MAX_SUBJECT_CHARS),
		at: nowIso(),
		...options.payload,
	};

	const staging = path.join(options.stagingDir, name);
	fs.writeFileSync(staging, JSON.stringify(body) + "\n", "utf-8");
	fs.renameSync(staging, path.join(options.targetDir, name));
	return { seq, file: name };
}
