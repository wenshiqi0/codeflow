/**
 * Offline fixture mode (contract §1.8): a scripted fake Codeflow driver, a
 * fake official evaluator, and a deterministic simulated clock loaded from a
 * fixture directory — no model, no network, no Docker.
 *
 * Fixture semantics (see tests/benchmark/fixtures/README.md):
 * - `attempts.json` scripts per-instance rounds (usage, tool calls,
 *   simulated clock advance), failed provider attempts, workspace writes, and
 *   an optional execution `infra_error` that terminates the attempt after the
 *   scripted rounds.
 * - `verdicts.json` scripts evaluator outcomes; an absent instance evaluates
 *   to `not_evaluated`.
 * - Rounds whose usage omits `cache_read`/`cache_write` mean *provider did
 *   not report* (null), not zero.
 * - The clock starts at a fixed epoch and advances only by `advance_ms`,
 *   which the driver applies before emitting the event, so wall-time budgets
 *   are deterministic offline. When the runner stops early (budget), the
 *   remaining script is never played (the generator is returned early).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { BenchmarkClock } from "./budgets";
import type {
	BenchmarkCodeflowDriver,
	BenchmarkEvaluator,
	BenchmarkVerdict,
	DriverEvent,
	DriverRound,
	DriverToolCall,
} from "./driver";
import type { ModelVisibleInstance } from "./dataset";
import type { AttemptUsage, AttemptUsageCost } from "./tokens";

export class BenchmarkFixtureError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BenchmarkFixtureError";
	}
}

/** The simulated clock's fixed starting epoch: 2026-01-01T00:00:00Z. */
export const FIXTURE_CLOCK_EPOCH_MS = Date.parse("2026-01-01T00:00:00.000Z");

/** Marks a driver as fixture-mode so the manifest records `driver_mode: "fixture"`. */
export const FIXTURE_DRIVER_TAG = "__codeflowBenchmarkFixtureDriver";

interface FixtureInstanceScript {
	rounds: DriverRound[];
	failedModelAttempts: Array<{ role: string; provider: string; model: string; error_class: string }>;
	workspaceFiles: Array<{ path: string; content: string }>;
	infraError: string | null;
}

interface FixtureData {
	modelNameOrPath: string;
	instances: Map<string, FixtureInstanceScript>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
	if (!isObject(value)) throw new BenchmarkFixtureError(`${what} must be an object`);
	return value;
}

function asString(value: unknown, what: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new BenchmarkFixtureError(`${what} must be a non-empty string`);
	}
	return value;
}

function asNumber(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new BenchmarkFixtureError(`${what} must be a finite number`);
	}
	return value;
}

function asNullableNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableNonnegativeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function asNullableIso(value: unknown): string | null {
	return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function parseCost(value: unknown): AttemptUsageCost | null {
	if (value === null || value === undefined) return null;
	const cost = asRecord(value, "cost");
	return {
		input: asNumber(cost.input, "cost.input"),
		output: asNumber(cost.output, "cost.output"),
		cache_read: asNumber(cost.cache_read, "cost.cache_read"),
		cache_write: asNumber(cost.cache_write, "cost.cache_write"),
		total: asNumber(cost.total, "cost.total"),
	};
}

/** Absent cache fields mean "provider did not report" (null); explicit numbers stay numbers. */
function parseUsage(value: unknown): AttemptUsage {
	const usage = asRecord(value, "usage");
	const usageOut: AttemptUsage = {
		input: asNumber(usage.input, "usage.input"),
		output: asNumber(usage.output, "usage.output"),
		reasoning: asNumber(usage.reasoning, "usage.reasoning"),
		cache_read: asNullableNumber(usage.cache_read),
		cache_write: asNullableNumber(usage.cache_write),
		total_tokens: asNumber(usage.total_tokens, "usage.total_tokens"),
		cost: parseCost(usage.cost),
	};
	return usageOut;
}

function parseToolCalls(value: unknown): DriverToolCall[] {
	if (value === null || value === undefined) return [];
	if (!Array.isArray(value)) throw new BenchmarkFixtureError("tool_calls must be an array");
	return value.map((raw, index) => {
		const call = asRecord(raw, `tool_calls[${index}]`);
		const status = asString(call.status, `tool_calls[${index}].status`);
		if (status !== "succeeded" && status !== "failed" && status !== "rejected" && status !== "incomplete") {
			throw new BenchmarkFixtureError(
				`tool_calls[${index}].status must be succeeded|failed|rejected|incomplete, got: ${status}`,
			);
		}
		const requestedAt = asNullableIso(call.requested_at);
		const resultAt = asNullableIso(call.result_at);
		return {
			call_id: asString(call.call_id, `tool_calls[${index}].call_id`),
			tool: asString(call.tool, `tool_calls[${index}].tool`),
			status,
			...(requestedAt === null ? {} : { requested_at: requestedAt }),
			...(resultAt === null ? {} : { result_at: resultAt }),
		};
	});
}

function parseRound(value: unknown): DriverRound {
	const round = asRecord(value, "round");
	const respondedAt = asNullableIso(round.at);
	const runId = typeof round.run_id === "string" && round.run_id.length > 0 ? round.run_id : null;
	return {
		...(respondedAt === null ? {} : { at: respondedAt }),
		run_id: runId,
			role: asString(round.role, "round.role"),
		provider: asString(round.provider, "round.provider"),
		model: asString(round.model, "round.model"),
		depth: asNullableNonnegativeInteger(round.depth),
		turn: asNullableNonnegativeInteger(round.turn),
		handoff_id: typeof round.handoff_id === "string" ? round.handoff_id : null,
		goal_id: typeof round.goal_id === "string" ? round.goal_id : null,
		lane: typeof round.lane === "string" ? round.lane : null,
		usage: parseUsage(round.usage),
		request_started_at: asNullableIso(round.request_started_at),
		tool_calls: parseToolCalls(round.tool_calls),
		advance_ms: typeof round.advance_ms === "number" ? round.advance_ms : 0,
	};
}

function parseScript(value: unknown): FixtureInstanceScript {
	const script = asRecord(value, "instance script");
	const rounds = Array.isArray(script.rounds) ? script.rounds.map(parseRound) : [];
	const failedRaw = Array.isArray(script.failed_model_attempts) ? script.failed_model_attempts : [];
	const failedModelAttempts = failedRaw.map((raw, index) => {
		const entry = asRecord(raw, `failed_model_attempts[${index}]`);
		return {
			role: asString(entry.role, `failed_model_attempts[${index}].role`),
			provider: asString(entry.provider, `failed_model_attempts[${index}].provider`),
			model: asString(entry.model, `failed_model_attempts[${index}].model`),
			error_class: asString(entry.error_class, `failed_model_attempts[${index}].error_class`),
		};
	});
	const workspaceRaw = isObject(script.workspace_files) ? script.workspace_files : {};
	const workspaceFiles = Object.entries(workspaceRaw).map(([file, content]) => ({
		path: file,
		content: typeof content === "string" ? content : String(content),
	}));
	return {
		rounds,
		failedModelAttempts,
		workspaceFiles,
		infraError: typeof script.infra_error === "string" && script.infra_error.length > 0 ? script.infra_error : null,
	};
}

function readFixtureJson(file: string, what: string): Record<string, unknown> {
	if (!fs.existsSync(file)) {
		throw new BenchmarkFixtureError(`fixture file not found (${what}): ${file}`);
	}
	try {
		return asRecord(JSON.parse(fs.readFileSync(file, "utf8")), what);
	} catch (error) {
		if (error instanceof BenchmarkFixtureError) throw error;
		throw new BenchmarkFixtureError(`fixture file is not valid JSON (${what}): ${file}`);
	}
}

function loadFixtureData(fixtureDir: string): FixtureData {
	const attempts = readFixtureJson(path.join(fixtureDir, "attempts.json"), "attempts.json");
	if (attempts.schema_version !== 1) {
		throw new BenchmarkFixtureError("attempts.json schema_version must be 1");
	}
	const modelNameOrPath = asString(attempts.model_name_or_path, "attempts.json model_name_or_path");
	const instancesRaw = asRecord(attempts.instances, "attempts.json instances");
	const instances = new Map<string, FixtureInstanceScript>();
	for (const [id, script] of Object.entries(instancesRaw)) {
		instances.set(id, parseScript(script));
	}
	return { modelNameOrPath, instances };
}

/** The fake model identity fixture predictions carry as `model_name_or_path`. */
export function readFixtureModelName(fixtureDir: string): string {
	return loadFixtureData(fixtureDir).modelNameOrPath;
}

const EMPTY_SCRIPT: FixtureInstanceScript = {
	rounds: [],
	failedModelAttempts: [],
	workspaceFiles: [],
	infraError: null,
};

const VERDICTS: ReadonlySet<string> = new Set(["resolved", "unresolved", "infra_error", "not_evaluated"]);

/**
 * Offline driver + evaluator + deterministic simulated clock from a fixture
 * directory. The clock advances only via `advance_ms`; the driver applies
 * each round's advance to the shared clock before emitting the event.
 */
export function loadFixtureDriver(fixtureDir: string): {
	driver: BenchmarkCodeflowDriver;
	evaluator: BenchmarkEvaluator;
	clock: BenchmarkClock;
} {
	const data = loadFixtureData(fixtureDir);
	const verdicts = readFixtureJson(path.join(fixtureDir, "verdicts.json"), "verdicts.json");
	if (verdicts.schema_version !== 1) {
		throw new BenchmarkFixtureError("verdicts.json schema_version must be 1");
	}
	const verdictMap = new Map<string, string>(
		Object.entries(asRecord(verdicts.instances, "verdicts.json instances")).map(([id, verdict]) => [
			id,
			asString(verdict, `verdict for ${id}`),
		]),
	);

	let nowMs = FIXTURE_CLOCK_EPOCH_MS;
	const clock: BenchmarkClock = { now: () => nowMs };

	function* attemptEvents(instance: ModelVisibleInstance): Generator<DriverEvent> {
		const script = data.instances.get(instance.instance_id) ?? EMPTY_SCRIPT;
		for (const write of script.workspaceFiles) {
			yield { type: "workspace_write", path: write.path, content: write.content };
		}
		for (const round of script.rounds) {
			nowMs += round.advance_ms ?? 0;
			yield { type: "round", round };
		}
		for (const failed of script.failedModelAttempts) {
			yield { type: "failed_model_attempt", attempt: failed };
		}
		if (script.infraError !== null) {
			yield { type: "infra_error", error_class: script.infraError };
		}
	}

	const driver: BenchmarkCodeflowDriver = {
		startAttempt(input) {
			return (async function* (): AsyncGenerator<DriverEvent> {
				yield* attemptEvents(input.instance);
			})();
		},
	};
	(driver as unknown as Record<string, unknown>)[FIXTURE_DRIVER_TAG] = true;

	const evaluator: BenchmarkEvaluator = {
		async evaluate(request): Promise<BenchmarkVerdict> {
			const verdict = verdictMap.get(request.instanceId);
			if (verdict === undefined) return "not_evaluated";
			if (!VERDICTS.has(verdict)) {
				throw new BenchmarkFixtureError(`invalid scripted verdict for ${request.instanceId}: ${verdict}`);
			}
			return verdict as BenchmarkVerdict;
		},
	};

	return { driver, evaluator, clock };
}
