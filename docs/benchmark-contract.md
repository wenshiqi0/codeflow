# Codeflow SWE-bench Verified Benchmark — Product Contract (SSOT)

Status: normative for implementation. This document fixes every open parameter
name and shape referenced by `docs/benchmark-design.md` (normative sections
§3–§11, §13). Where the design doc and this contract disagree on a name, this
contract wins; where they disagree on intent, the design doc wins.

Implementation target: `runtime/lib/benchmark/index.ts` (public module),
`runtime/cli/benchmark.ts` (CLI adapter), dispatched from `runtime/bin/codeflow`.
Acceptance tests live in `tests/benchmark/` and assert only the surfaces fixed
here. Internal decomposition below `runtime/lib/benchmark/` is free as long as
`index.ts` re-exports the public API with the exact names below.

Everything in this contract is executable offline: no network, no Docker, no
model calls, no dataset download. The official Docker evaluator is only used in
real (non-fixture) runs.

---

## 1. Module surface

`runtime/lib/benchmark/index.ts` must export, with exactly these names:

### 1.1 Dataset and leakage boundary

```ts
export const BENCHMARK_DATASET_SCHEMA_VERSION = 1;

/** A full SWE-bench Verified record, evaluator-only fields included. */
export interface BenchmarkInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  patch: string;            // gold patch — evaluator-only
  test_patch: string;       // evaluator-only
  FAIL_TO_PASS: string[];   // evaluator-only
  PASS_TO_PASS: string[];   // evaluator-only
  environment_setup_commit?: string;
  hints_text?: string;      // evaluator-only
  created_at?: string;
  version?: string;
  [key: string]: unknown;   // future dataset fields must not leak either
}

/** The model-visible instance: an explicit allowlist projection. */
export interface ModelVisibleInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
}

export const MODEL_VISIBLE_INSTANCE_FIELDS: readonly string[]; // exactly the 4 keys above

/** Must construct a fresh object from the allowlist — never copy-and-delete. */
export function projectModelVisibleInstance(instance: BenchmarkInstance): ModelVisibleInstance;

export class BenchmarkDatasetError extends Error;

export interface BenchmarkDataset {
  dataset_id: string;
  split: string;
  revision: string;        // exact 40-hex sha, never an alias
  harness_commit: string;  // exact 40-hex sha
  instances: BenchmarkInstance[];
  source: string;          // snapshot path or hub id, as passed in
}

export function loadBenchmarkDataset(source: string): BenchmarkDataset;
export function selectInstances(
  dataset: BenchmarkDataset,
  allowlist?: string[] | null,
): BenchmarkInstance[];
```

`loadBenchmarkDataset` rules:

- A path to a local snapshot JSON file (the only form the offline tests use) or
  a hub dataset id (`owner/name`, real mode).
- Snapshot file shape (see `tests/benchmark/fixtures/verified-snapshot.json`):

```json
{
  "schema_version": 1,
  "dataset_id": "SWE-bench/SWE-bench_Verified",
  "split": "test",
  "revision": "<40-hex>",
  "harness_commit": "<40-hex>",
  "instances": [ { "...full BenchmarkInstance..." } ]
}
```

- Validation failures throw `BenchmarkDatasetError`: wrong `schema_version`;
  `revision` or `harness_commit` missing or not 40-hex (a moving alias such as
  `main`/`latest` is rejected — the design forbids recording an unfixed
  revision); empty `instances`; an instance missing any of the four visible
  fields or with an empty value; duplicate `instance_id`.
- `selectInstances` filters by `instance_id`, preserving dataset order. An
  allowlist id not present in the dataset throws `BenchmarkDatasetError`.
  `null`/`undefined` allowlist selects all instances in dataset order.

The design-pinned reference values (for real runs; the fixture snapshot uses
the same shapes with fixture content):

- dataset `SWE-bench/SWE-bench_Verified`, split `test`, revision
  `78f471bf655a3137b2e8a75af1501690ec009ec3`
- harness commit `7a21e05772954cc81471ae19d56f436cecf43c54`

### 1.2 Budgets

```ts
export type BudgetName = "model_rounds" | "tool_calls" | "total_tokens" | "wall_seconds";

export interface BenchmarkBudgets {
  model_rounds: number;   // default 120
  tool_calls: number;     // default 400
  total_tokens: number;   // default 3_000_000, provider-reported
  wall_seconds: number;   // default 5400 (90 min), safety stop only
}

export const DEFAULT_BENCHMARK_BUDGETS: BenchmarkBudgets;

export class BenchmarkBudgetError extends Error;

/** CLI spellings model-rounds / tool-calls / total-tokens / wall-seconds map to snake_case. */
export function parseBudgetOverrides(entries: string[]): Partial<BenchmarkBudgets>;

export interface BudgetState {
  model_rounds: number;
  tool_calls: number;
  total_tokens: number;
  wall_seconds: number;
}

/** First cap reached, in canonical order model_rounds, tool_calls, total_tokens, wall_seconds; null if none. */
export function budgetTerminatedBy(state: BudgetState, budgets: BenchmarkBudgets): BudgetName | null;

export interface BenchmarkClock {
  now(): number; // epoch ms
}
```

Stop semantics: budgets are per instance attempt. A cap is reached when the
current count is `>=` the cap (a 120-round cap means at most 120 completed
rounds; the attempt stops before issuing round 121). Wall time counts from
attempt start using the injected clock. On termination the runner stops pulling
driver events, still extracts the patch, still submits the prediction, and
still requests a verdict — a budget stop never forces `unresolved`.

### 1.3 Model rounds

One assistant model response with usage = one completed `model_round`. A
response with N tool calls is 1 round + N calls. Provider requests that fail
before any assistant response are `failed_model_attempts`, never completed
rounds. All roles count in `model_rounds_total`.

```ts
/** Roles counted as support models; everything else (incl. unknown roles) is primary. */
export const SUPPORT_MODEL_ROLES: readonly string[];
// Fixed content: ["tester", "verify", "supervisor", "title-compressor", "zipper"]
// Primary roles: planner, architect, coder.

export function classifyModelRole(role: string): "primary" | "support";
```

### 1.4 Tool-call ledger (privacy-safe)

```ts
export const TOOL_CALL_SCHEMA_VERSION = 1;

/** The only top-level keys a ledger row may carry. */
export const TOOL_CALL_RECORD_FIELDS: readonly string[];
// ["schema_version", "kind", "call_id", "tool", "status", "at",
//  "run_id", "role", "depth", "handoff_id", "goal_id", "lane",
//  "provider", "model"]

export type ToolCallRecordKind = "requested" | "result";
export type ToolCallTerminalStatus = "succeeded" | "failed" | "rejected";

export interface ToolCallRecord {
  schema_version: 1;
  kind: ToolCallRecordKind;            // "result" rows carry the terminal status
  call_id: string;                     // dedup/association key
  tool: string;                        // tool name only, e.g. "bash"
  status: ToolCallTerminalStatus | null; // null exactly when kind === "requested"
  at: string;                          // ISO timestamp
  run_id: string | null;
  role: string;
  depth: number;
  handoff_id: string | null;
  goal_id: string | null;
  lane: string | null;
  provider: string;  // provider of the assistant response that EMITTED the call
  model: string;     // model of the assistant response that EMITTED the call
}

/** Returns violation messages; empty array means the record is privacy-safe and well-formed. */
export function validateToolCallRecord(record: unknown): string[];

export function appendToolCallRecord(file: string, record: ToolCallRecord): void; // throws on violations
export function readToolCallRecords(file: string): ToolCallRecord[];

export interface ToolCallSummary {
  total: number;        // unique call ids — equals requested
  requested: number;
  completed: number;    // succeeded + failed + rejected
  succeeded: number;
  failed: number;
  rejected: number;
  incomplete: number;   // requested, no terminal result before process end
  by_tool: Record<string, number>;
}

export function summarizeToolCalls(records: ToolCallRecord[]): ToolCallSummary;
```

Counting rules:

- Every row carries DIRECT `provider`/`model` attribution sourced from the
  context that emitted the call (the assistant response — the same
  attribution the usage/failed-attempt ledgers record for it), so by-model
  counts never need role→model inference; the write path refuses rows
  without non-empty `provider`/`model` (fallback when no assistant context
  was observed: `"unknown"`).
- Dedup by `call_id` within an attempt: repeated rows for one id are one call.
- One bash call containing several shell commands is exactly one call; the
  ledger has no field that could carry command text, so no sub-count can exist.
- Retries are new call ids, hence new calls.
- Rejected and errored calls still count in `total` and are classified.
- `requested === completed + incomplete` must hold.

### 1.5 Token and cache metrics

```ts
export const ATTEMPT_USAGE_SCHEMA_VERSION = 1;

export interface AttemptUsageCost {
  input: number; output: number; cache_read: number; cache_write: number; total: number;
}

/** One completed model round as recorded per attempt. cache null = provider did not report. */
export interface AttemptUsageRecord {
  schema_version: 1;
  at: string;
  attempt: number;
  role: string;
  provider: string;
  model: string;
  handoff_id: string | null;
  goal_id: string | null;
  lane: string | null;
  usage: {
    input: number;
    output: number;
    reasoning: number;
    cache_read: number | null;
    cache_write: number | null;
    total_tokens: number;
    cost: AttemptUsageCost | null;   // informational only
  };
}

export function appendAttemptUsageRecord(file: string, record: AttemptUsageRecord): void;
export function readAttemptUsageRecords(file: string): AttemptUsageRecord[];

export interface TokenUsageSummary {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;      // unreported counts as 0 in sums
  cache_write: number;
  total_tokens: number;
  cost_total: number | null;
  cache_metrics_available: boolean; // true iff >=1 record and every record reported both cache fields
  cache_hit_rate: number | null;    // null when unavailable or denominator is 0
}

export function summarizeTokenUsage(records: AttemptUsageRecord[]): TokenUsageSummary;
```

Cache semantics (design §8):

```text
cache_hit_rate = sum(cache_read) / sum(input + cache_read + cache_write)
```

Token-weighted, never an average of per-round percentages. Explicit zero and
unreported are different: `cache_read: 0` keeps `cache_metrics_available: true`;
an absent field forces `false` and a `null` hit rate for the whole attempt.
`resolved == 0` makes every per-resolved metric `null` — no division by zero,
no `Infinity`.

### 1.6 Per-attempt metrics

```ts
export interface FailedModelAttempt {
  schema_version: 1;
  at: string;
  role: string;
  provider: string;
  model: string;
  error_class: string;   // short token, e.g. "provider_timeout"; never message text
}

export interface AttemptMetricsInput {
  usageRecords: AttemptUsageRecord[];
  failedModelAttempts: FailedModelAttempt[];
  toolCallRecords: ToolCallRecord[];
  wallSeconds: number;
  terminatedBy: BudgetName | null;
}

export interface AttemptMetrics {
  model_rounds_total: number;       // == usageRecords.length
  primary_model_rounds: number;
  support_model_rounds: number;
  failed_model_attempts: number;
  tool_calls_total: number;
  tool_call_counts: { requested: number; completed: number; succeeded: number; failed: number; rejected: number; incomplete: number };
  tool_calls_by_tool: Record<string, number>;
  tool_calls_per_model_round: number | null; // null when model_rounds_total === 0
  tokens: TokenUsageSummary;
  wall_seconds: number;
  terminated_by: BudgetName | null;
}

export function buildAttemptMetrics(input: AttemptMetricsInput): AttemptMetrics;
```

Model rounds are derived from the per-attempt usage ledger row count (one
assistant usage row == one completed round), never from session transcripts.

### 1.7 Driver and evaluator seams

The runner drives an attempt by pulling events from an injected driver. This is
the only place a fake Codeflow substitutes for the real one.

```ts
export interface DriverToolCall {
  call_id: string;
  tool: string;
  status: "succeeded" | "failed" | "rejected" | "incomplete";
}

export interface DriverRound {
  role: string;
  provider: string;
  model: string;
  handoff_id?: string | null;
  goal_id?: string | null;
  lane?: string | null;
  usage: AttemptUsageRecord["usage"];
  tool_calls?: DriverToolCall[];  // tool calls emitted by this one response
  advance_ms?: number;            // simulated wall-clock advance for this round
}

export type DriverEvent =
  | { type: "round"; round: DriverRound }
  | { type: "failed_model_attempt"; attempt: Omit<FailedModelAttempt, "schema_version" | "at">; advance_ms?: number }
  | { type: "workspace_write"; path: string; content: string }
  | { type: "infra_error"; error_class: string } // terminates the attempt as infra failure
  | { type: "tool_calls"; role: string; provider: string; model: string;
      handoff_id?: string | null; goal_id?: string | null;
      lane?: string | null; calls: DriverToolCall[] }; // real-mode instrumentation
```

The `tool_calls` variant is the real-mode instrumentation path: the production
Codeflow driver streams each tool call when it terminates (attributed to the
role AND provider/model recorded on the staging row — the emitting context,
never role→model inference), so tool-call budgets supervise the live process
without waiting for the next model response. Fixture drivers attach a
response's calls to its round event; both forms produce identical ledger rows
(the round's provider/model is the emitting context for its attached calls).

/** The ONLY data a Codeflow run may see for an instance. */
export interface DriverAttemptInput {
  instance: ModelVisibleInstance; // the allowlist projection — nothing else
  workspaceDir: string;
  budgets: BenchmarkBudgets;
  attempt: number;               // 1-based
  modelConfig: string;
  clock: BenchmarkClock;
  wallDeadlineMs: number;        // absolute attempt deadline; enforced during event silence
}

export interface BenchmarkCodeflowDriver {
  startAttempt(input: DriverAttemptInput): AsyncIterable<DriverEvent>;
}

export interface PredictionEntry {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

export interface BenchmarkEvaluator {
  evaluate(request: {
    prediction: PredictionEntry;
    instanceId: string;
    evaluationRunId: string;
    predictionsFile?: string; // file holding the attempt's prediction with exactly the official keys;
                               // the real-mode harness reads a file, fixture evaluators ignore it
  }): Promise<"resolved" | "unresolved" | "infra_error" | "not_evaluated">;
}
```

### 1.7.1 Real-mode process seams (production defaults)

Real mode (no `--fixture`) spawns external commands. Each has an override
seam and a production default under `runtime/scripts/benchmark/` (the live
boundary — real model credentials, network, and Docker; exercised only in
live runs):

| seam (env var) | spawned as | production default |
| --- | --- | --- |
| `CODEFLOW_BENCHMARK_DRIVER_BIN` | `<bin> --workspace <dir> --attempt <n> --model-config <id>`; stdin = the 4-key projection; stdout = NDJSON DriverEvents | `codeflow-driver.ts` (a real `codeflow exec` run per attempt, instrumented by `runtime/extensions/benchmark-ledger`) |
| `CODEFLOW_BENCHMARK_REPO_CLONE_BIN` | `<bin> <repo> <base_commit> <workspaceDir>` | `repo-clone.sh` (GitHub clone + checkout, HEAD verified) |
| `CODEFLOW_BENCHMARK_HARNESS_BIN` | `<bin> --predictions <file> --run-id <id> --instance <id>` | `swebench-harness.sh` (official SWE-bench harness at the pinned commit; exit 127 = unavailable) |
| `CODEFLOW_BENCHMARK_DATASET_FETCH_BIN` | `<bin> <hub-id>`; stdout = one snapshot document | `hub-fetch.ts` (HuggingFace datasets server, design-pinned Verified revision) |

The runner validates every spawned driver event structurally
(`parseDriverEvent`); a malformed line is a protocol violation
(infra_error). On a budget stop the runner stops reading and the process is
SIGTERMed (SIGKILL after a grace period). A non-zero driver exit after a
natural end is an execution infra_error. Workspace provisioning failures are
attempt infra_errors; provisioning only ever writes inside the attempt's
workspace directory.

Runner protocol per instance attempt:

1. Allocate a fresh workspace dir, run id, session; `attempt` starts at 1.
   In real mode the workspace is provisioned first as a fresh git working
   tree at exactly `base_commit` (the clone seam); in fixture mode it is an
   empty `git init` workspace. A provisioning failure is an attempt
   infra_error.
2. Pull driver events, applying them in order: `workspace_write` writes into
   `workspaceDir`; `round` appends one usage row plus tool-call rows (a
   `requested` row per call; a `result` row for terminal statuses;
   `incomplete` gets only the `requested` row); the driver advances the
   injected clock by `advance_ms` (fixture drivers simulate time this way; the
   real driver simply consumes real time);
   `failed_model_attempt` records a failed attempt row.
3. After each round/failed attempt, recompute the budget state and stop when
   `budgetTerminatedBy` returns a cap.
4. Natural end (iterator exhausted) or stop: extract the patch
   (`prepareBenchmarkWorkspace`/`extractPatch` below), write the attempt's
   own `prediction.jsonl` (one official-keys line), append the prediction to
   the shared `predictions.jsonl`, allocate a fresh `evaluation_run_id`, and
   request the verdict with the attempt's prediction file.
5. `infra_error` event: extract the patch, append the prediction, record
   verdict `infra_error` without calling the evaluator (no silent in-attempt
   retry, never disguised as `unresolved`).

Workspace and patch extraction (git-based, offline):

```ts
/** git init + one initial empty commit with a fixed identity; no network. */
export function prepareBenchmarkWorkspace(dir: string): void;
/** git add -A, then the cached binary diff against HEAD; "" when nothing changed. */
export function extractPatch(dir: string): string;
```

Evaluation run ids:

```ts
/** Deterministic, unique per (benchmark run, instance, attempt). */
export function newEvaluationRunId(benchmarkRunId: string, instanceId: string, attempt: number): string;
// Format: `${benchmarkRunId}--${caseDirName(instanceId)}--a${attempt}`
```

The official harness caches by `run_id + instance_id`, so every distinct
attempt (or re-run) must produce a distinct evaluation run id.

Predictions (official field contract):

```ts
/** Appends one complete JSON line to <outDir>/predictions.jsonl; throws unless the entry has exactly the three official keys. */
export function appendPredictionEntry(outDir: string, entry: PredictionEntry): string;
/** Throws on any unparsable or non-conforming line. */
export function readPredictions(file: string): PredictionEntry[];
```

### 1.8 Runner and fixture mode

```ts
export interface BenchmarkRunOptions {
  dataset: string;                     // snapshot path (tests) or hub id (real)
  instances?: string[] | null;         // allowlist, dataset order preserved
  outDir: string;
  budgets?: Partial<BenchmarkBudgets>; // overrides on top of the defaults
  concurrency?: number;                // default 1; >= 1
  modelConfig?: string;                // default "default"
  driver: BenchmarkCodeflowDriver;
  evaluator: BenchmarkEvaluator;
  clock?: BenchmarkClock;              // default: real clock
  codeflowCommit?: string;             // default: git rev-parse HEAD of the Codeflow checkout
}

export interface BenchmarkRunResult {
  benchmarkRunId: string;
  outDir: string;
  report: BenchmarkReport;
}

export function runBenchmark(options: BenchmarkRunOptions): Promise<BenchmarkRunResult>;

/** Offline driver + evaluator + deterministic simulated clock from a fixture directory. */
export function loadFixtureDriver(fixtureDir: string): {
  driver: BenchmarkCodeflowDriver;
  evaluator: BenchmarkEvaluator;
  clock: BenchmarkClock; // advances only via advance_ms; starts at a fixed epoch
};
```

`benchmarkRunId` format: `bench-<YYYYMMDD-HHMMSS>-<4 hex>`, matching the
existing run-id convention.

Fixture directory layout (see `tests/benchmark/fixtures/`):

```text
<fixtureDir>/attempts.json    # scripted driver behavior per instance
<fixtureDir>/verdicts.json    # fake official evaluator outcomes
```

`attempts.json`:

```json
{
  "schema_version": 1,
  "model_name_or_path": "fixture/fake-model",
  "instances": {
    "<instance_id>": {
      "rounds": [ { "role": "...", "provider": "...", "model": "...",
                    "usage": { "input": 0, "output": 0, "reasoning": 0,
                               "cache_read": 0, "cache_write": 0,
                               "total_tokens": 0, "cost": null },
                    "tool_calls": [ { "call_id": "...", "tool": "...", "status": "..." } ],
                    "advance_ms": 0 } ],
      "failed_model_attempts": [ { "role": "...", "provider": "...", "model": "...", "error_class": "..." } ],
      "workspace_files": { "fix.py": "..." },
      "infra_error": "docker_daemon_unavailable"
    }
  }
}
```

Omitted `cache_read`/`cache_write` keys mean "provider did not report"
(`null`), not zero. An `infra_error` string terminates the attempt after the
scripted rounds. The fixture driver plays events in file order; when the
runner stops early (budget), the remaining script is never played.

`verdicts.json`:

```json
{ "schema_version": 1, "instances": { "<instance_id>": "resolved" } }
```

An instance absent from `verdicts.json` evaluates to `not_evaluated`. In
fixture mode the clock is simulated (advances only by `advance_ms`), so
wall-time budgets are deterministic offline.

### 1.9 Report

```ts
export const BENCHMARK_REPORT_SCHEMA_VERSION = 1;

export interface BenchmarkReport { /* shape below */ }

/** Reads <outDir> artifacts only — manifest, case files, predictions. No driver, no evaluator, no model, no network. */
export function buildBenchmarkReport(outDir: string): BenchmarkReport;
```

`report.json` shape (exact top-level keys):

```json
{
  "schema_version": 1,
  "benchmark_run_id": "bench-...",
  "generated_at": "<ISO>",
  "counts": { "instances": 0, "attempts": 0, "resolved": 0, "unresolved": 0, "infra_error": 0, "not_evaluated": 0 },
  "resolved_rate": null,
  "resolved_rate_denominator": 0,
  "budget_terminations": { "model_rounds": 0, "tool_calls": 0, "total_tokens": 0, "wall_seconds": 0, "none": 0 },
  "model_rounds": { "total": 0, "median": 0, "p90": 0, "primary": 0, "support": 0, "failed_attempts": 0 },
  "tool_calls": { "total": 0, "median": 0, "p90": 0 },
  "tokens": { "total": 0, "median": 0, "p90": 0 },
  "per_resolved": { "rounds": null, "tool_calls": null, "tokens": null },
  "cache": { "read": 0, "write": 0, "hit_rate": null, "metrics_available": false },
  "tool_calls_per_model_round": null,
  "breakdowns": { "by_role": {}, "by_model": {}, "by_lane": {}, "by_tool": {} },
  "wall_time": { "total_seconds": 0, "median_seconds": 0, "p90_seconds": 0, "not_ranked": true },
  "comparison_keys": {
    "dataset_id": "", "dataset_split": "", "dataset_revision": "",
    "instance_set_digest": "", "budgets": { "model_rounds": 0, "tool_calls": 0, "total_tokens": 0, "wall_seconds": 0 },
    "tool_network": "disabled", "harness_commit": ""
  }
}
```

Rules:

- `resolved_rate = resolved / (resolved + unresolved)`. The denominator is
  valid official verdicts only; `infra_error` and `not_evaluated` counts stay
  visible in `counts` so missing results cannot be hidden by shrinking the
  denominator. `resolved_rate` is `null` when the denominator is 0.
- `per_resolved.{rounds,tool_calls,tokens}` divide the sums over ALL attempts
  (resolved, unresolved, infra_error, not_evaluated, budget-terminated alike)
  by the resolved count — failed-but-infra-valid consumption stays in the
  numerator. `null` when `resolved == 0`.
- `cache.hit_rate` is the token-weighted formula across all attempts;
  `null` unless every contributing attempt had `cache_metrics_available`.
- `median` = middle value, or the mean of the two middle values for even n;
  `p90` = nearest-rank `sorted[max(0, ceil(0.9 * n) - 1)]`, over per-attempt
  totals (attempts with zero included).
- `breakdowns.by_*` map a name (`by_model` uses `provider/model`) to
  `{ "model_rounds": 0, "tool_calls": 0, "total_tokens": 0 }`.
- `wall_time.not_ranked` is always `true`.
- `instance_set_digest` = sha256 hex of the sorted selected instance ids
  joined by `\n`.
- No composite score exists: no top-level key contains `score` (the report
  must not grow a subjective weighted total; cost stays informational).

## 2. CLI surface

Dispatched from `runtime/bin/codeflow`. Report/help/fixture paths run before
credential loading; real mode runs after the normal `CODEFLOW_HOME/.env` load
so provider keys and dynamic endpoint variables reach the benchmark driver:

```text
codeflow benchmark run    --dataset <snapshot-path | hub-id>
                          [--instances <file>]        # JSON array or newline-separated ids
                          [--pilot]                   # the fixed 20-instance dev pilot
                                                      # (first 20 in dataset order, design §2)
                          [--out <dir>]               # default .codeflow/benchmark/<benchmark-run-id>
                          [--concurrency <n>]         # default 1
                          [--budget <name>=<value>]... # repeatable; model-rounds|tool-calls|total-tokens|wall-seconds
                          [--model-config <id>]        # default "default"
                          [--fixture <dir>]            # offline driver+evaluator+simulated clock

codeflow benchmark report --run <dir>                  # benchmark out dir
                          [--out <file>]               # default <run>/report.json
```

- `codeflow --help` lists `benchmark`.
- `codeflow benchmark --help`, `... run --help`, `... report --help` exit 0
  with usage on stdout.
- Argument errors (unknown subcommand, unknown option, missing `--dataset` /
  `--run`, malformed `--budget`, bad `--concurrency`) exit **2** with
  `codeflow benchmark: error: ...` on stderr — a stable non-zero code.
  Argument validation (options, budget syntax, concurrency) happens before
  dataset/fixture resolution, so a malformed flag is reported as such even
  when the dataset path is also wrong.
- `benchmark report` rebuilds `report.json` from existing predictions and
  evaluation artifacts with no model, driver, or evaluator invocation.
- Real mode (no `--fixture`) is the production default; `--pilot` selects the
  fixed 20-instance dev pilot (first 20 instances in dataset order, recorded
  as the manifest allowlist) when no `--instances` allowlist is given. When
  any attempt ends `not_evaluated`, the run output explicitly reports
  unexecuted external verification (design §14).
- Unknown top-level verbs keep failing exactly as before (exit 1).

## 3. Artifacts

One benchmark run writes, under `<outDir>`:

```text
benchmark-run.json                      # manifest (atomic replace)
predictions.jsonl                       # append-only, one complete line per attempt
report.json                             # atomic replace; rebuildable
cases/<slug>/case.json                  # per-instance verdicts + metrics (atomic replace)
cases/<slug>/attempts/<n>/usage.jsonl   # append-only round ledger
cases/<slug>/attempts/<n>/tool-calls.jsonl  # append-only tool ledger
cases/<slug>/attempts/<n>/prediction.jsonl   # the attempt's own official prediction
cases/<slug>/attempts/<n>/workspace/    # the attempt workspace (repo@base_commit in real mode)
cases/<slug>/attempts/<n>/driver-ledger/     # real mode only: staging ledgers written by the
                                             # spawned Codeflow run's instrumentation
cases/<slug>/attempts/<n>/codeflow-runs/     # real mode only: the attempt's Codeflow run
                                             # artifacts, outside the workspace so the
                                             # extracted patch stays exactly the model's work
```

`<slug> = caseDirName(instance_id)`: `instance_id` with every `/` replaced by
`__` (SWE-bench ids embed `owner/repo`).

Every JSON/JSONL artifact carries `schema_version`. JSON documents use the
existing atomic-replace primitive (`writeJsonAtomic`); ledgers are append-only
with complete lines, so an interrupted run can never parse half a document.

`benchmark-run.json` (manifest, exact keys):

```json
{
  "schema_version": 1,
  "benchmark_run_id": "bench-...",
  "created_at": "<ISO>",
  "dataset": { "dataset_id": "", "split": "", "revision": "<40-hex>", "source": "local-snapshot|hub", "instance_count": 0 },
  "instances": { "allowlist": null, "selected": ["..."] },
  "harness": { "commit": "<40-hex>" },
  "codeflow_commit": "<40-hex>",
  "model_config": "",
  "concurrency": 1,
  "tool_network": "disabled",
  "model_provider_network": "disabled",
  "budgets": { "defaults": {}, "overrides": null, "effective": {} },
  "driver_mode": "fixture|codeflow"
}
```

- The manifest must record the exact dataset id, split, resolved revision
  (40-hex), harness commit, Codeflow commit, actual concurrency, network
  declarations, and effective budgets. Never a moving alias.
- `tool_network` defaults to `"disabled"` and is `"disabled"` in fixture mode.
- `model_provider_network` is `"disabled"` in fixture mode (no provider is
  called) and `"required"` in real mode — the two networks are declared
  separately, per design §4.

`case.json` (exact keys):

```json
{
  "schema_version": 1,
  "instance_id": "...",
  "attempts": [
    {
      "attempt": 1,
      "execution_status": "completed|infra_error",
      "terminated_by": null,
      "evaluation_run_id": "bench-...--demo__demo-1001-resolved--a1",
      "verdict": "resolved|unresolved|infra_error|not_evaluated",
      "started_at": "<ISO>",
      "ended_at": "<ISO>",
      "metrics": { "...AttemptMetrics..." }
    }
  ],
  "final_verdict": "resolved|unresolved|infra_error|not_evaluated"
}
```

`predictions.jsonl` lines carry exactly the three official keys:
`instance_id`, `model_name_or_path`, `model_patch`. One line per attempt; the
latest attempt for an instance is the official prediction (`instance_id` stays
unique from the harness's point of view because only the last line per
instance is submitted). `model_patch` is the git diff extracted from the
workspace; an empty patch is representable as `""`.

## 4. Classification

Only the official evaluator decides correctness. Per attempt:

- `resolved` — official evaluator passed.
- `unresolved` — evaluator completed, patch did not pass.
- `infra_error` — execution or evaluator infrastructure produced no valid
  verdict; recorded loudly, never retried inside the attempt, never reported
  as `unresolved`.
- `not_evaluated` — no verdict yet.

`terminated_by` is orthogonal and may coexist with any verdict.

## 5. Acceptance mapping

Each acceptance criterion of design §13 maps to tests under `tests/benchmark/`
(see `tests/benchmark/TESTPLAN.md` for the case index). The suite is
deterministic offline; red before implementation is expected, but files must
fail with contract messages against the surfaces above, never crash on import.
