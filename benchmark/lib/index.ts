/**
 * Codeflow SWE-bench Verified benchmark capability — public module.
 *
 * Contract: docs/benchmark-contract.md (SSOT for names and shapes) over the
 * normative design doc docs/benchmark-design.md. Everything here is
 * executable offline: fixture mode needs no model, network, or Docker; the
 * official Docker evaluator is only used in real (non-fixture) runs.
 *
 * `index.ts` re-exports the public API with the exact contract names; the
 * internal decomposition below this directory is free to evolve.
 */

export {
	BENCHMARK_DATASET_SCHEMA_VERSION,
	BenchmarkDatasetError,
	type BenchmarkDataset,
	type BenchmarkInstance,
	type ModelVisibleInstance,
	MODEL_VISIBLE_INSTANCE_FIELDS,
	projectModelVisibleInstance,
	loadBenchmarkDataset,
	selectInstances,
} from "./dataset";

export {
	BenchmarkBudgetError,
	type BenchmarkBudgets,
	DEFAULT_BENCHMARK_BUDGETS,
	type BudgetName,
	parseBudgetOverrides,
	validateBudgetOverrides,
	type BudgetState,
	budgetTerminatedBy,
	type BenchmarkClock,
} from "./budgets";

export { SUPPORT_MODEL_ROLES, classifyModelRole } from "./rounds";

export {
	TOOL_CALL_SCHEMA_VERSION,
	TOOL_CALL_RECORD_FIELDS,
	type ToolCallRecord,
	type ToolCallRecordKind,
	type ToolCallTerminalStatus,
	validateToolCallRecord,
	appendToolCallRecord,
	readToolCallRecords,
	type ToolCallSummary,
	summarizeToolCalls,
} from "../../runtime/lib/observability/tool-execution";

export {
	ATTEMPT_USAGE_SCHEMA_VERSION,
	type AttemptUsageCost,
	type AttemptUsage,
	type AttemptUsageRecord,
	appendAttemptUsageRecord,
	readAttemptUsageRecords,
	type TokenUsageSummary,
	summarizeTokenUsage,
} from "../../runtime/lib/observability/model-usage";

export {
	FAILED_ATTEMPT_SCHEMA_VERSION,
	type FailedModelAttempt,
	type AttemptMetricsInput,
	type AttemptMetrics,
	buildAttemptMetrics,
} from "./metrics";

export {
	type WallBreakdown,
	summarizeWallBreakdown,
} from "../../runtime/lib/observability/timing";

export {
	type WasteSummary,
	type ContextGrowthSummary,
	summarizeWaste,
	summarizeContextGrowth,
} from "../../runtime/lib/observability/usage-analysis";

export {
	type DriverToolCall,
	type DriverRound,
	type DriverEvent,
	type DriverToolCallsEvent,
	type DriverAttemptInput,
	type BenchmarkCodeflowDriver,
	type PredictionEntry,
	type BenchmarkVerdict,
	type BenchmarkEvaluator,
} from "./driver";

export {
	caseDirName,
	prepareBenchmarkWorkspace,
	seedBenchmarkWorkspaceHygiene,
	extractPatch,
	extractPatchDetailed,
	type PatchExtraction,
} from "./workspace";

export { newBenchmarkRunId, newEvaluationRunId } from "./ids";

export { appendPredictionEntry, appendPredictionLine, readPredictions } from "./predictions";

export { PILOT_INSTANCE_COUNT, pilotAllowlist } from "./pilot";

export {
	BENCHMARK_DRIVER_BIN_ENV,
	BENCHMARK_HARNESS_BIN_ENV,
	BENCHMARK_REPO_CLONE_BIN_ENV,
	BENCHMARK_DATASET_FETCH_BIN_ENV,
	BENCHMARK_SCRIPTS_DIR,
	BenchmarkProcessError,
	defaultDriverBin,
	defaultHarnessBin,
	defaultRepoCloneBin,
	defaultDatasetFetchBin,
	parseDriverEvent,
	createProcessCodeflowDriver,
	createProcessHarnessEvaluator,
	createSourceCloneWorkspaceProvisioner,
	fetchHubDatasetDocument,
	terminateProcess,
	type BenchmarkWorkspaceProvisioner,
	type ProcessCodeflowDriverOptions,
	type ProcessHarnessEvaluatorOptions,
	type SourceCloneProvisionerOptions,
	type HubFetchOptions,
} from "./process";

export {
	BenchmarkFixtureError,
	FIXTURE_CLOCK_EPOCH_MS,
	loadFixtureDriver,
	readFixtureModelName,
} from "./fixtures";

export {
	type BenchmarkRunOptions,
	type BenchmarkRunResult,
	runBenchmark,
	defaultCodeflowCommit,
} from "./runner";

export {
	providerExemptHostnames,
	toolNetworkWallEnv,
	TOOL_NETWORK_MARKER_ENV,
	TOOL_NETWORK_WALL_PROXY_URL,
} from "./tool-network";

export {
	BENCHMARK_REPORT_SCHEMA_VERSION,
	BenchmarkReportError,
	type BenchmarkReport,
	type BreakdownTotals,
	buildBenchmarkReport,
} from "./report";

export {
	HANDOFF_STATE_PROJECTION_SCHEMA_VERSION,
	OBSERVABILITY_BLOCKED_REASONS,
	HandoffObservabilityError,
	type HandoffStateProjection,
	type HandoffStateScan,
	type HandoffStateTelemetryFile,
	type ObservabilityBlockedReason,
	projectHandoffState,
	scanHandoffStates,
	readHandoffStateProjections,
	type HandoffObservabilitySummary,
	summarizeHandoffStates,
} from "../../runtime/lib/observability/handoff-state";
