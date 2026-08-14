/**
 * Run-scoped shared fact ledger.
 *
 * Isolating roles buys independence at a real cost: every fresh process
 * rediscovers what an earlier one already confirmed. The planner grep-walks
 * its way to `src/router.ts:42`, then coder starts blank and walks the same
 * path again. This ledger carries those confirmed facts across the isolation
 * boundary without carrying the context that produced them.
 *
 * It holds one flow's working consensus, not durable knowledge. Scope is the
 * run: a new plan starts a new ledger, and anything worth keeping crosses over
 * as prose in the planner's final report, never by inheriting this file.
 *
 * Three properties make it trustworthy enough to read without re-verifying:
 *
 * - **Only the CLI writes it.** Entries arrive through `handoff finish`, so a
 *   fact is a side effect of a validated receipt. No model writes this file,
 *   in keeping with the rule that state is mechanical.
 * - **A claim must be checkable.** Every entry carries a locator — a real
 *   in-repo `path`, a `symbol`, or a literal `value`. Paths are verified to
 *   exist at write time, because the CLI can do that mechanically. A claim
 *   with nowhere to check it is an opinion.
 * - **Corrections append.** A later role that finds a fact stale writes a
 *   `supersede` record pointing at the original id. History stays intact and
 *   the correction is attributable; readers see only the surviving view.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Locators, in the order rendered. `path` is verified; the others are taken
 * at face value because the CLI cannot check them. */
const LOCATOR_FIELDS = ["path", "symbol", "value"] as const;

const ALLOWED_FIELDS = new Set([
	"claim",
	"path",
	"line",
	"symbol",
	"value",
	"supersedes",
	"reason",
]);

/**
 * Caps on a single handoff's contribution. The ledger is only useful while it
 * stays readable; a role that needs more than this is describing its process
 * instead of naming facts.
 */
export const MAX_FACTS_PER_HANDOFF = 12;
export const MAX_CLAIM_CHARS = 200;

export const LEDGER_NAME = "facts.jsonl";

/** A mechanical rejection: unverifiable claim, unknown field, bad target. */
export class FactError extends Error {}

export interface FactInput {
	claim?: unknown;
	path?: unknown;
	line?: unknown;
	symbol?: unknown;
	value?: unknown;
	supersedes?: unknown;
	reason?: unknown;
}

export interface FactRecord {
	id: string;
	kind: "fact" | "supersede";
	role: string;
	handoff_id: string;
	claim: string;
	path?: string;
	line?: number;
	symbol?: string;
	value?: string;
	supersedes?: string;
	reason?: string;
}

/** The ledger for one run. One flow, one file. */
export function ledgerPath(runDir: string): string {
	return path.join(runDir, LEDGER_NAME);
}

/**
 * Every record in order. A damaged line is skipped, never fatal: a partially
 * readable ledger must degrade to fewer facts rather than break a run that
 * would otherwise succeed.
 */
function readRecords(ledger: string): FactRecord[] {
	let content: string;
	try {
		content = fs.readFileSync(ledger, "utf-8");
	} catch {
		return [];
	}
	const records: FactRecord[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && typeof parsed.id === "string") {
				records.push(parsed as FactRecord);
			}
		} catch {
			// Skip the damaged line.
		}
	}
	return records;
}

/** Confirm a path locator names a real file inside the repository. */
function verifyPath(value: unknown): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new FactError("path must be a non-empty string");
	}
	if (path.isAbsolute(value)) {
		throw new FactError(`path must be repository-relative, got absolute path: ${value}`);
	}
	// Reject traversal before touching the filesystem: a fact about a file
	// outside the repository is not this run's business.
	const normalized = path.normalize(value);
	if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
		throw new FactError(`path escapes the repository: ${value}`);
	}
	if (!fs.existsSync(value)) {
		throw new FactError(
			`path does not exist: ${value} (a fact must be checkable at the moment it is recorded)`,
		);
	}
	return value;
}

function isPresent(value: unknown): boolean {
	return value !== undefined && value !== null && value !== "";
}

/** Validate one entry and return its normalized form. */
function validate(entry: unknown, index: number, knownIds: Set<string>): Partial<FactRecord> {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		throw new FactError(`fact ${index} must be a JSON object`);
	}
	const input = entry as Record<string, unknown>;

	const unknown = Object.keys(input)
		.filter((key) => !ALLOWED_FIELDS.has(key))
		.sort();
	if (unknown.length > 0) {
		throw new FactError(
			`fact ${index} has unknown field(s): ${unknown.join(", ")}; ` +
				`allowed: ${[...ALLOWED_FIELDS].sort().join(", ")}`,
		);
	}

	if (typeof input.claim !== "string" || input.claim.trim() === "") {
		throw new FactError(`fact ${index} is missing a non-empty claim`);
	}
	const claim = input.claim.trim();
	if (claim.length > MAX_CLAIM_CHARS) {
		throw new FactError(
			`fact ${index} claim exceeds ${MAX_CLAIM_CHARS} characters; ` +
				"name the fact, do not narrate it",
		);
	}

	if (!LOCATOR_FIELDS.some((field) => isPresent(input[field]))) {
		throw new FactError(
			`fact ${index} needs a locator (one of ${LOCATOR_FIELDS.join(", ")}); ` +
				"a claim nobody can check is an opinion, not a fact",
		);
	}

	const normalized: Partial<FactRecord> = { claim };

	if (isPresent(input.path)) {
		normalized.path = verifyPath(input.path);
	}

	if (input.line !== undefined && input.line !== null) {
		const line = input.line;
		if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
			throw new FactError(`fact ${index} line must be a positive integer`);
		}
		normalized.line = line;
	}

	for (const field of ["symbol", "value"] as const) {
		if (isPresent(input[field])) {
			if (typeof input[field] !== "string") {
				throw new FactError(`fact ${index} ${field} must be a string`);
			}
			normalized[field] = (input[field] as string).trim();
		}
	}

	if (isPresent(input.supersedes)) {
		const target = input.supersedes;
		if (typeof target !== "string" || !knownIds.has(target)) {
			throw new FactError(
				`fact ${index} supersedes unknown fact id ${JSON.stringify(target)}; ` +
					"a correction must name the record it replaces",
			);
		}
		normalized.supersedes = target;
		if (isPresent(input.reason)) {
			if (typeof input.reason !== "string") {
				throw new FactError(`fact ${index} reason must be a string`);
			}
			normalized.reason = input.reason.trim();
		}
	} else if (isPresent(input.reason)) {
		throw new FactError(
			`fact ${index} carries a reason without supersedes; a reason explains a correction`,
		);
	}

	return normalized;
}

/**
 * Append a validated batch, returning the records written.
 *
 * The whole batch is validated before anything is written, so a rejected
 * entry cannot leave a half-applied batch on disk.
 */
export function appendFacts(
	ledger: string,
	entries: unknown,
	role: string,
	handoffId: string,
): FactRecord[] {
	if (entries === undefined || entries === null) return [];
	if (!Array.isArray(entries)) {
		throw new FactError("facts must be a JSON array");
	}
	if (entries.length === 0) return [];
	if (entries.length > MAX_FACTS_PER_HANDOFF) {
		throw new FactError(
			`a handoff may record at most ${MAX_FACTS_PER_HANDOFF} facts, ` +
				`got ${entries.length}; keep only what the next role needs`,
		);
	}

	const existing = readRecords(ledger);
	const knownIds = new Set(existing.map((record) => record.id));
	const nextIndex = existing.length + 1;

	const staged: FactRecord[] = [];
	for (const [offset, entry] of entries.entries()) {
		const normalized = validate(entry, offset, knownIds);
		staged.push({
			id: `f${nextIndex + offset}`,
			kind: normalized.supersedes ? "supersede" : "fact",
			role,
			handoff_id: handoffId,
			...normalized,
		} as FactRecord);
		// A batch may correct a fact it recorded earlier in the same batch.
		knownIds.add(staged[staged.length - 1].id);
	}

	fs.mkdirSync(path.dirname(ledger), { recursive: true });
	fs.appendFileSync(
		ledger,
		staged.map((record) => JSON.stringify(record)).join("\n") + "\n",
		"utf-8",
	);
	return staged;
}

/** The surviving view: every record minus those a later one replaced. */
export function materialize(ledger: string): FactRecord[] {
	const records = readRecords(ledger);
	const superseded = new Set(
		records
			.filter((record) => record.kind === "supersede" && record.supersedes)
			.map((record) => record.supersedes as string),
	);
	return records.filter((record) => !superseded.has(record.id));
}

function locator(record: FactRecord): string {
	if (record.path) {
		return record.line ? `${record.path}:${record.line}` : record.path;
	}
	if (record.symbol) return record.symbol;
	return record.value ?? "";
}

/** Plain-text view for context injection. Empty when there is nothing. */
export function render(ledger: string): string {
	const view = materialize(ledger);
	if (view.length === 0) return "";
	return view
		.map((record) => `${record.id}: ${record.claim} — ${locator(record)} [${record.role}]`)
		.join("\n");
}
