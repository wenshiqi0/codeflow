/**
 * The benchmark runner (design §4, contract §1.8).
 *
 * Per instance attempt:
 *   fresh isolated workspace -> driver events -> ledgers -> wall-safety stop or
 *   natural end -> extract git-diff patch -> official prediction -> unique
 *   evaluation run id -> verdict -> per-case artifacts -> report.
 *
 * Fairness rules baked in:
 * - Budgets stop inference but never discard work: the patch is still
 *   extracted, submitted, and evaluated; `terminated_by` is orthogonal to the
 *   verdict.
 * - Execution/evaluator infrastructure failure is `infra_error`, recorded
 *   loudly, never retried inside the attempt, never disguised as unresolved.
 * - Instances run in stable dataset order; default concurrency 1 (any
 *   explicit concurrency is recorded in the manifest). predictions.jsonl is
 *   appended in dataset order regardless of completion order.
 * - The driver sees ONLY the allowlist projection of the instance.
 * - Every attempt gets a fresh Codeflow run id, workspace, and evaluation run
 *   id; the runner never touches dataset caches or source clones.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { writeJsonAtomic } from "../../runtime/lib/paths";
import {
	BenchmarkDatasetError,
	datasetSourceKind,
	loadBenchmarkDataset,
	projectModelVisibleInstance,
	selectInstances,
	type BenchmarkDataset,
	type BenchmarkInstance,
} from "./dataset";
import {
	DEFAULT_BENCHMARK_BUDGETS,
	BenchmarkBudgetError,
	CONSUMPTION_METRICS,
	budgetTerminatedBy,
	validateBudgetOverrides,
	type BenchmarkBudgets,
	type BenchmarkClock,
	type BudgetName,
	type BudgetState,
} from "./budgets";
import {
	appendAttemptUsageRecord,
	appendJsonlRow,
	ATTEMPT_USAGE_SCHEMA_VERSION,
	type AttemptUsageRecord,
} from "../../runtime/lib/observability/model-usage";
import { appendToolCallRecord, TOOL_CALL_SCHEMA_VERSION, type ToolCallRecord } from "../../runtime/lib/observability/tool-execution";
import type { ToolOperationKind } from "../../runtime/lib/observability/tool-execution";
import {
	buildAttemptMetrics,
	FAILED_ATTEMPT_SCHEMA_VERSION,
	type AttemptMetrics,
	type FailedModelAttempt,
} from "./metrics";
import type {
	BenchmarkCodeflowDriver,
	BenchmarkEvaluator,
	BenchmarkVerdict,
	DriverAttemptInput,
	DriverEvent,
	DriverToolCall,
	PredictionEntry,
} from "./driver";
import {
	caseDirName,
	extractPatchDetailed,
	prepareBenchmarkWorkspace,
	seedBenchmarkWorkspaceHygiene,
} from "./workspace";
import { appendPredictionEntry, appendPredictionLine } from "./predictions";
import { newAttemptRunId, newBenchmarkRunId, newEvaluationRunId } from "./ids";
import { FIXTURE_DRIVER_TAG } from "./fixtures";
import { pilotAllowlist } from "./pilot";
import type { BenchmarkWorkspaceProvisioner } from "./process";
import { buildBenchmarkReport, type BenchmarkReport } from "./report";
import {
	COMMITMENT_STATE_PROJECTION_SCHEMA_VERSION,
	scanCommitmentStates,
	type CommitmentStateProjection,
} from "../../runtime/lib/observability/commitment-state";
import { scanRunFacts } from "../../runtime/lib/observability/run-facts";
import {
	BENCHMARK_CASE_SCHEMA_VERSION,
	BENCHMARK_MANIFEST_SCHEMA_VERSION,
	OBSERVATION_SCHEMA_VERSION,
	type BenchmarkManifest,
	type CaseAttemptRecord,
	type CaseFile,
	type InterventionFlags,
	type ObservationConfig,
} from "./artifacts";

export interface BenchmarkRunOptions {
	/** Snapshot path (tests/fixtures) or hub id (real mode). */
	dataset: string;
	/** Allowlist; dataset order preserved. */
	instances?: string[] | null;
	outDir: string;
	/** Overrides on top of the defaults. */
	budgets?: Partial<BenchmarkBudgets>;
	/** Default 1; must be >= 1. Recorded in the manifest. */
	concurrency?: number;
	/** Default "default". */
	modelConfig?: string;
	driver: BenchmarkCodeflowDriver;
	evaluator: BenchmarkEvaluator;
	/** Default: real clock. */
	clock?: BenchmarkClock;
	/** Default: git rev-parse HEAD of the Codeflow checkout. */
	codeflowCommit?: string;
	/** Pre-allocated benchmark run id (CLI default out dir names itself after it). */
	benchmarkRunId?: string;
	/** Prediction `model_name_or_path`; defaults to the model config id. */
	modelNameOrPath?: string;
	/** Defaults to detecting the fixture driver tag. */
	driverMode?: "fixture" | "codeflow";
	/**
	 * Real-mode workspace provisioning: a fresh isolated repo@base_commit per
	 * attempt (the clone seam). Omitted in fixture mode, which provisions an
	 * empty git-init workspace instead. A provisioning failure is an attempt
	 * infra_error — never retried in-attempt, never unresolved.
	 */
	workspaceProvisioner?: BenchmarkWorkspaceProvisioner;
	/** Use the fixed 20-instance pilot allowlist (design §2) when no explicit --instances was given. */
	pilot?: boolean;
	/** Default 1. Values >1 are pilot/diagnostic multi-attempt runs, not official scores. */
	attempts?: number;
	/** Observation code is uniform; these flags identify only the behavior treatment. */
	interventionFlags?: Partial<InterventionFlags>;
	/** True only when the model-visible request itself explicitly requires decomposition. */
	requestNamedSplit?: boolean;
}

export interface BenchmarkRunResult {
	benchmarkRunId: string;
	outDir: string;
	report: BenchmarkReport;
}

const VERDICTS: ReadonlySet<string> = new Set(["resolved", "unresolved", "infra_error", "not_evaluated"]);

/** git rev-parse HEAD of the Codeflow checkout containing this module. */
export function defaultCodeflowCommit(fromDir: string = import.meta.dir): string {
	const result = Bun.spawnSync(["git", "-C", fromDir, "rev-parse", "HEAD"]);
	if (result.exitCode !== 0) {
		throw new Error(
			`could not resolve the Codeflow commit (git rev-parse HEAD from ${fromDir}); ` +
				"pass codeflowCommit explicitly",
		);
	}
	const commit = new TextDecoder().decode(result.stdout).trim();
	if (!/^[0-9a-f]{40}$/.test(commit)) {
		throw new Error(`unexpected Codeflow commit from git rev-parse HEAD: ${commit}`);
	}
	return commit;
}

function isFixtureDriver(driver: BenchmarkCodeflowDriver): boolean {
	return (driver as unknown as Record<string, unknown>)[FIXTURE_DRIVER_TAG] === true;
}

interface RunContext {
	benchmarkRunId: string;
	outDir: string;
	budgets: BenchmarkBudgets;
	modelConfig: string;
	modelNameOrPath: string;
	clock: BenchmarkClock;
	driver: BenchmarkCodeflowDriver;
	evaluator: BenchmarkEvaluator;
	/** null in fixture mode (empty git-init workspace). */
	provisionWorkspace: BenchmarkWorkspaceProvisioner | null;
	observation: ObservationConfig;
}

interface AttemptOutcome {
	prediction: PredictionEntry;
	record: CaseAttemptRecord;
}

function toolCallRow(
	base: {
		task_id: string;
		worker_kind: "worker" | "service";
		commitment_id: string | null;
		goal_id: string | null;
		provider: string;
		model: string;
	},
	at: string,
	call_id: string,
	tool: string,
	status: ToolCallRecord["status"],
	operationKind?: ToolOperationKind,
): ToolCallRecord {
	return {
		schema_version: TOOL_CALL_SCHEMA_VERSION as 4,
		kind: status === null ? "requested" : "result",
		call_id,
		tool,
		...(operationKind === undefined ? {} : { operation_kind: operationKind }),
		status,
		at,
		task_id: base.task_id,
		worker_kind: base.worker_kind,
		commitment_id: base.commitment_id,
		goal_id: base.goal_id,
		provider: base.provider,
		model: base.model,
	};
}

const failedRow = (failed: FailedModelAttempt): Record<string, unknown> =>
	failed as unknown as Record<string, unknown>;

/**
 * Ledger rows for a batch of calls: a requested row always; a terminal
 * result row when the call finished; "incomplete" gets only the requested
 * row. Rows carry id/name/status/timestamps plus Task/Goal/Commitment,
 * provider/model of the emitting context (the round for round-attached
 * calls, the event for standalone ones) — never payloads.
 */
function appendToolCalls(
	toolFile: string,
	toolRecords: ToolCallRecord[],
	attribution: {
		task_id: string;
		worker_kind: "worker" | "service";
		commitment_id: string | null;
		goal_id: string | null;
		provider: string;
		model: string;
	},
	defaultAt: string,
	calls: ReadonlyArray<DriverToolCall>,
): void {
	for (const call of calls) {
		const requestedAt = call.requested_at ?? defaultAt;
		const requested = toolCallRow(
			attribution,
			requestedAt,
			call.call_id,
			call.tool,
			null,
			call.operation_kind,
		);
		appendToolCallRecord(toolFile, requested);
		toolRecords.push(requested);
		if (call.status !== "incomplete") {
			const result = toolCallRow(
				attribution,
					call.result_at ?? defaultAt,
				call.call_id,
				call.tool,
				call.status as "succeeded" | "failed" | "rejected",
				call.operation_kind,
			);
			appendToolCallRecord(toolFile, result);
			toolRecords.push(result);
		}
	}
}

async function runInstanceAttempt(
	context: RunContext,
	instance: BenchmarkInstance,
	attemptNo: number,
): Promise<AttemptOutcome> {
	const slug = caseDirName(instance.instance_id);
	const caseDir = path.join(context.outDir, "cases", slug);
	const attemptDir = path.join(caseDir, "attempts", String(attemptNo));
	const usageFile = path.join(attemptDir, "usage.jsonl");
	const toolFile = path.join(attemptDir, "tool-calls.jsonl");
	const failedFile = path.join(attemptDir, "failed-model-attempts.jsonl");
	const workspaceDir = path.join(attemptDir, "workspace");
	const attemptPredictionFile = path.join(attemptDir, "prediction.jsonl");
	const codeflowRunsDir = path.join(attemptDir, "codeflow-runs");
	const commitmentTelemetryFile = path.join(attemptDir, "telemetry", "commitments.json");

	const clock = context.clock;
	const attemptRunId = newAttemptRunId();
	const startMs = clock.now();
	const startedAt = new Date(startMs).toISOString();

	const usageRecords: AttemptUsageRecord[] = [];
	const toolRecords: ToolCallRecord[] = [];
	const failedAttempts: FailedModelAttempt[] = [];
	const state: BudgetState = {
		model_rounds: 0,
		tool_calls: 0,
		fresh_tokens: 0,
		total_tokens: 0,
		wall_seconds: 0,
	};
	let terminatedBy: BudgetName | null = null;
	let infraFailure = false;
	let timeToFirstPatchSeconds: number | null = null;

	// Fresh isolated workspace per attempt. Real mode provisions a git working
	// tree at exactly base_commit from the dataset source repo (the clone
	// seam); fixture mode keeps the offline empty-init workspace. Provisioning
	// only ever writes inside the attempt's workspace directory.
	let workspaceReady = true;
	try {
		if (context.provisionWorkspace !== null) {
			context.provisionWorkspace(projectModelVisibleInstance(instance), workspaceDir);
			seedBenchmarkWorkspaceHygiene(workspaceDir);
		} else {
			prepareBenchmarkWorkspace(workspaceDir);
		}
	} catch {
		// Provisioning infrastructure failure is an attempt infra_error: no
		// driver runs, no evaluator is called, nothing is fabricated.
		workspaceReady = false;
		infraFailure = true;
	}

	const elapsedSeconds = (): number => (clock.now() - startMs) / 1000;
	const recordFirstPatch = (): void => {
		if (timeToFirstPatchSeconds !== null || !workspaceReady) return;
		const status = Bun.spawnSync(["git", "-C", workspaceDir, "status", "--porcelain", "--untracked-files=all"]);
		if (status.exitCode === 0 && new TextDecoder().decode(status.stdout).trim().length > 0) {
			timeToFirstPatchSeconds = elapsedSeconds();
		}
	};

	// The ONLY instance data a driver may ever see: the allowlist projection.
	const input: DriverAttemptInput = {
		instance: projectModelVisibleInstance(instance),
		workspaceDir,
		budgets: context.budgets,
		attempt: attemptNo,
		modelConfig: context.modelConfig,
		clock,
		wallDeadlineMs: startMs + context.budgets.wall_seconds * 1000,
	};

	type Decision = "continue" | "stop";

	const checkBudget = (): Decision => {
		state.wall_seconds = elapsedSeconds();
		const cap = budgetTerminatedBy(state, context.budgets);
		if (cap !== null) {
			terminatedBy = cap;
			return "stop";
		}
		return "continue";
	};

	const applyEvent = (event: DriverEvent): Decision => {
		switch (event.type) {
			case "workspace_write": {
				const target = path.join(workspaceDir, event.path);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, event.content, "utf8");
				recordFirstPatch();
				return "continue";
			}
			case "round": {
				const round = event.round;
				const at = round.at ?? new Date(clock.now()).toISOString();
				const usageRow: AttemptUsageRecord = {
					schema_version: ATTEMPT_USAGE_SCHEMA_VERSION as 1,
					at,
					request_started_at: round.request_started_at ?? null,
					attempt: attemptNo,
					task_id: round.task_id ?? attemptRunId,
					worker_kind: round.worker_kind,
					provider: round.provider,
					model: round.model,
					turn: round.turn ?? null,
					commitment_id: round.commitment_id ?? null,
					goal_id: round.goal_id ?? null,
					usage: round.usage,
				};
				appendAttemptUsageRecord(usageFile, usageRow);
				usageRecords.push(usageRow);

				const attribution = {
					task_id: attemptRunId,
					worker_kind: round.worker_kind,
					commitment_id: round.commitment_id ?? null,
					goal_id: round.goal_id ?? null,
					// The round IS the emitting context for its attached calls.
					provider: round.provider,
					model: round.model,
				};
				const calls = round.tool_calls ?? [];
				appendToolCalls(toolFile, toolRecords, attribution, at, calls);
				recordFirstPatch();

				state.model_rounds += 1;
				state.tool_calls += calls.length;
			if (round.usage.cache_read === null || round.usage.cache_write === null) {
				state.fresh_tokens = null;
			} else if (state.fresh_tokens !== null) {
				state.fresh_tokens += round.usage.input + round.usage.output;
			}
			state.total_tokens += round.usage.total_tokens;
				return checkBudget();
			}
			case "tool_calls": {
				// Real-mode instrumentation: calls that terminated between
				// rounds, attributed to the Worker kind and provider/model that
				// emitted them (recorded on the event, never inferred).
				const at = new Date(clock.now()).toISOString();
				appendToolCalls(toolFile, toolRecords, {
					task_id: attemptRunId,
					worker_kind: event.worker_kind,
					commitment_id: event.commitment_id ?? null,
					goal_id: event.goal_id ?? null,
					provider: event.provider,
					model: event.model,
				}, at, event.calls);
				state.tool_calls += event.calls.length;
				recordFirstPatch();
				return checkBudget();
			}
			case "failed_model_attempt": {
				const failed: FailedModelAttempt = {
					schema_version: FAILED_ATTEMPT_SCHEMA_VERSION as 1,
					at: new Date(clock.now()).toISOString(),
					task_id: event.attempt.task_id,
					worker_kind: event.attempt.worker_kind,
					provider: event.attempt.provider,
					model: event.attempt.model,
					error_class: event.attempt.error_class,
				};
				appendJsonlRow(failedFile, failedRow(failed));
				failedAttempts.push(failed);
				return checkBudget();
			}
			case "infra_error": {
				// Infrastructure failure: no silent in-attempt retry, never an
				// unresolved. The remaining script is never played.
				infraFailure = true;
				return "stop";
			}
			case "budget_stop": {
				terminatedBy = event.budget;
				return "stop";
			}
		}
	};

	if (workspaceReady && checkBudget() === "continue") {
		try {
			attemptLoop: for await (const event of context.driver.startAttempt(input)) {
				if (applyEvent(event) === "stop") break attemptLoop;
			}
		} catch {
			// A driver/execution failure is infrastructure, not a model result.
			infraFailure = true;
		}
	}

	// Runtime observability is collected after the driver closes its runs but
	// before metrics are built. The benchmark report later reads this canonical
	// artifact rather than reaching back into runtime state files.
	let commitmentStates: CommitmentStateProjection[] = [];
	let runFactsRecords = [] as ReturnType<typeof scanRunFacts>;
	let commitmentTelemetryAvailable = false;
	if (fs.existsSync(codeflowRunsDir)) {
		const scan = scanCommitmentStates(codeflowRunsDir);
		commitmentStates = scan.states;
		commitmentTelemetryAvailable = true;
		writeJsonAtomic(commitmentTelemetryFile, {
			schema_version: COMMITMENT_STATE_PROJECTION_SCHEMA_VERSION,
			states: commitmentStates,
		});
		runFactsRecords = scanRunFacts(codeflowRunsDir);
	}

	const endedAt = new Date(clock.now()).toISOString();
	state.wall_seconds = elapsedSeconds();

	// A stop never discards work: extract whatever the workspace holds. A
	// workspace that could not be provisioned has nothing to extract.
	const extraction = workspaceReady
		? extractPatchDetailed(workspaceDir)
		: { patch: "", strippedBinaryPaths: [] as string[] };
	const patch = extraction.patch;
	const prediction: PredictionEntry = {
		instance_id: instance.instance_id,
		model_name_or_path: context.modelNameOrPath,
		model_patch: patch,
	};
	// The attempt's own prediction file: exactly one official-keys line the
	// real-mode harness reads (the shared predictions.jsonl stays in dataset
	// order and is written as attempts complete).
	appendPredictionLine(attemptPredictionFile, prediction);

	// Fresh evaluation run id per (benchmark run, instance, attempt).
	const evaluationRunId = newEvaluationRunId(context.benchmarkRunId, instance.instance_id, attemptNo);
	let verdict: BenchmarkVerdict;
	if (infraFailure) {
		// Recorded loudly without calling the evaluator.
		verdict = "infra_error";
	} else {
		try {
			const returned = await context.evaluator.evaluate({
				prediction,
				instanceId: instance.instance_id,
				evaluationRunId,
				predictionsFile: attemptPredictionFile,
			});
			verdict = VERDICTS.has(returned) ? returned : "infra_error";
		} catch {
			// Evaluator infrastructure failure is still an infra error, never unresolved.
			verdict = "infra_error";
		}
	}

	const metrics: AttemptMetrics = buildAttemptMetrics({
		usageRecords,
		failedModelAttempts: failedAttempts,
		toolCallRecords: toolRecords,
		commitmentStates,
		commitmentTelemetryAvailable,
		runFactsRecords,
		timeToFirstPatchSeconds,
		wallStartedAtMs: startMs,
		wallSeconds: state.wall_seconds,
		terminatedBy,
	});

	const attemptRecord: CaseAttemptRecord = {
		attempt: attemptNo,
		execution_status: infraFailure ? "infra_error" : "completed",
		terminated_by: terminatedBy,
		evaluation_run_id: evaluationRunId,
		verdict,
		started_at: startedAt,
		ended_at: endedAt,
		metrics,
		observation: context.observation,
		patch_hygiene: {
			stripped_binary_paths: extraction.strippedBinaryPaths,
		},
	};
	return { prediction, record: attemptRecord };
}

export async function runBenchmark(options: BenchmarkRunOptions): Promise<BenchmarkRunResult> {
	const dataset: BenchmarkDataset = loadBenchmarkDataset(options.dataset);
	const allowlist = options.instances ?? (options.pilot === true ? pilotAllowlist(dataset) : null);
	const selected = selectInstances(dataset, allowlist);
	if (selected.length === 0) {
		throw new BenchmarkDatasetError("instance selection is empty: nothing to run");
	}

	try {
		validateBudgetOverrides(options.budgets);
	} catch (error) {
		if (error instanceof BenchmarkBudgetError) throw error;
		throw error;
	}
	const budgets: BenchmarkBudgets = { ...DEFAULT_BENCHMARK_BUDGETS, ...options.budgets };

	const concurrency = options.concurrency ?? 1;
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new BenchmarkBudgetError(`concurrency must be an integer >= 1, got: ${String(concurrency)}`);
	}
	const attemptsPerInstance = options.attempts ?? 1;
	if (!Number.isInteger(attemptsPerInstance) || attemptsPerInstance < 1) {
		throw new BenchmarkBudgetError(
			`attempts must be an integer >= 1, got: ${String(attemptsPerInstance)}`,
		);
	}

	const clock: BenchmarkClock = options.clock ?? { now: () => Date.now() };
	const benchmarkRunId = options.benchmarkRunId ?? newBenchmarkRunId();
	const modelConfig = options.modelConfig ?? "default";
	const driverMode = options.driverMode ?? (isFixtureDriver(options.driver) ? "fixture" : "codeflow");
	const overrides =
		options.budgets !== undefined && options.budgets !== null && Object.keys(options.budgets).length > 0
			? { ...options.budgets }
			: null;

	const interventionFlags: InterventionFlags = {
		work_commitment_claims: true,
		run_facts: true,
		collaborate_capabilities: true,
		...options.interventionFlags,
	};
	const observation: ObservationConfig = {
		schema_version: OBSERVATION_SCHEMA_VERSION as 3,
		intervention_flags: interventionFlags,
		request_named_split: options.requestNamedSplit ?? false,
	};

	const manifest: BenchmarkManifest = {
		schema_version: BENCHMARK_MANIFEST_SCHEMA_VERSION as 7,
		benchmark_run_id: benchmarkRunId,
		created_at: new Date(clock.now()).toISOString(),
		dataset: {
			dataset_id: dataset.dataset_id,
			split: dataset.split,
			revision: dataset.revision,
			source: datasetSourceKind(options.dataset),
			instance_count: dataset.instances.length,
		},
		instances: {
			allowlist,
			selected: selected.map((instance) => instance.instance_id),
		},
		harness: { commit: dataset.harness_commit },
		codeflow_commit: options.codeflowCommit ?? defaultCodeflowCommit(),
		model_config: modelConfig,
		concurrency,
		attempts_per_instance: attemptsPerInstance,
		// Agent tool network and model-provider network are declared separately (design §4).
		tool_network: "disabled",
		model_provider_network: driverMode === "fixture" ? "disabled" : "required",
		termination_budgets: {
			defaults: { ...DEFAULT_BENCHMARK_BUDGETS },
			overrides,
			effective: budgets,
		},
		consumption_metrics: { axes: [...CONSUMPTION_METRICS] },
		driver_mode: driverMode,
		observation,
	};

	fs.mkdirSync(options.outDir, { recursive: true });
	writeJsonAtomic(path.join(options.outDir, "benchmark-run.json"), manifest);

	const context: RunContext = {
		benchmarkRunId,
		outDir: options.outDir,
		budgets,
		modelConfig,
		modelNameOrPath: options.modelNameOrPath ?? modelConfig,
		clock,
		driver: options.driver,
		evaluator: options.evaluator,
		provisionWorkspace: options.workspaceProvisioner ?? null,
		observation,
	};

	const outcomes: AttemptOutcome[][] = Array.from({ length: selected.length }, () => []);
	let fetchIndex = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = fetchIndex++;
			if (index >= selected.length) return;
			for (let attemptNo = 1; attemptNo <= attemptsPerInstance; attemptNo++) {
				outcomes[index].push(await runInstanceAttempt(context, selected[index], attemptNo));
			}
		}
	};
	const workerCount = Math.max(1, Math.min(concurrency, selected.length));
	await Promise.all(Array.from({ length: workerCount }, () => worker()));

	// One official-keys prediction per instance remains the harness-facing
	// contract. Prefer the first resolved attempt; otherwise retain attempt 1.
	for (let index = 0; index < selected.length; index++) {
		const instanceOutcomes = outcomes[index];
		if (instanceOutcomes.length !== attemptsPerInstance) {
			throw new BenchmarkBudgetError(
				`internal benchmark error: ${selected[index].instance_id} produced ${String(instanceOutcomes.length)} of ${String(attemptsPerInstance)} attempts`,
			);
		}
		const representative =
			instanceOutcomes.find((outcome) => outcome.record.verdict === "resolved") ?? instanceOutcomes[0];
		appendPredictionEntry(options.outDir, representative.prediction);
		const verdicts = instanceOutcomes.map((outcome) => outcome.record.verdict);
		const finalVerdict = verdicts.includes("resolved")
			? "resolved"
			: verdicts.includes("unresolved")
				? "unresolved"
				: verdicts.includes("infra_error")
					? "infra_error"
					: "not_evaluated";
		const caseFile: CaseFile = {
			schema_version: BENCHMARK_CASE_SCHEMA_VERSION as 5,
			instance_id: selected[index].instance_id,
			attempts: instanceOutcomes.map((outcome) => outcome.record),
			final_verdict: finalVerdict as CaseFile["final_verdict"],
		};
		writeJsonAtomic(
			path.join(options.outDir, "cases", caseDirName(selected[index].instance_id), "case.json"),
			caseFile,
		);
	}

	const report = buildBenchmarkReport(options.outDir);
	writeJsonAtomic(path.join(options.outDir, "report.json"), report);

	return { benchmarkRunId, outDir: options.outDir, report };
}
