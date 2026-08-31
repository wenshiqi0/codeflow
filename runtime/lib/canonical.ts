import { createHash } from "node:crypto";

function normalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalize);
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.filter((key) => record[key] !== undefined)
				.map((key) => [key, normalize(record[key])]),
		);
	}
	return value;
}

/** Byte-stable JSON for persisted semantic objects and prompt prefixes. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(normalize(value));
}

export function contentHash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function contentId(prefix: "c" | "r", value: unknown): string {
	return `${prefix}_${contentHash(value)}`;
}
