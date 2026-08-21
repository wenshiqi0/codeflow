/**
 * predictions.jsonl — the official SWE-bench field contract (design §10).
 *
 * The official harness consumes this file directly, so the shape is not ours
 * to bend: exactly instance_id / model_name_or_path / model_patch per line,
 * complete lines only. An empty patch is representable as "" — "no change"
 * is a legal prediction. Appends write whole lines so an interrupted run can
 * never leave half a JSON object behind, and reads throw loudly on any
 * malformed or non-conforming line instead of silently skipping corruption.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PredictionEntry } from "./driver";

const OFFICIAL_KEYS = ["instance_id", "model_name_or_path", "model_patch"] as const;

export function predictionsFile(outDir: string): string {
	return path.join(outDir, "predictions.jsonl");
}

function validateEntry(entry: unknown): asserts entry is PredictionEntry {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		throw new Error("prediction entry must be an object");
	}
	const record = entry as Record<string, unknown>;
	const keys = Object.keys(record);
	for (const key of keys) {
		if (!(OFFICIAL_KEYS as readonly string[]).includes(key)) {
			throw new Error(`prediction entry carries a non-official key: ${key}`);
		}
	}
	for (const key of OFFICIAL_KEYS) {
		if (typeof record[key] !== "string") {
			throw new Error(`prediction entry field ${key} must be a string`);
		}
	}
}

/** Appends one complete JSON line to a specific file; throws unless the entry has exactly the three official keys. */
export function appendPredictionLine(file: string, entry: PredictionEntry): string {
	validateEntry(entry);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
	return file;
}

/** Appends one complete JSON line to <outDir>/predictions.jsonl; throws unless the entry has exactly the three official keys. */
export function appendPredictionEntry(outDir: string, entry: PredictionEntry): string {
	validateEntry(entry);
	fs.mkdirSync(outDir, { recursive: true });
	const file = predictionsFile(outDir);
	fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
	return file;
}

/** Throws on any unparsable or non-conforming line. */
export function readPredictions(file: string): PredictionEntry[] {
	let content: string;
	try {
		content = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const entries: PredictionEntry[] = [];
	const lines = content.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line.trim().length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			throw new Error(
				`predictions file ${file} has a malformed line ${index + 1} ` +
					`(append-only writers must leave whole lines only): ${(error as Error).message}`,
			);
		}
		try {
			validateEntry(parsed);
		} catch (error) {
			throw new Error(`predictions file ${file} line ${index + 1}: ${(error as Error).message}`);
		}
		entries.push(parsed);
	}
	return entries;
}
