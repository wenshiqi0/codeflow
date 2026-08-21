# Design B — benchmark-facing runtime observability（B1–B4 + prompt cache）

状态：已实现第一批完整功能面，待评审
基线：PR #7（`922d93e`，feat: add SWE-bench Verified benchmark support）

## 0. 架构边界

PR #7 的 `benchmark-ledger` 不是 benchmark 专属数据层；它采集的是 Codeflow runtime 的通用行为事实。Benchmark 只是 observability facts 的一个消费者。

```text
Runtime observability
  model usage / tool execution / provider failure /
  handoff terminal state / derived timing spans

Benchmark harness
  dataset / runner / evaluator / report /
  pass@N / dispersion / SWE-bench verdicts
```

当前实现采用渐进边界：

- `runtime/lib/observability/` 承接 handoff projection、timing 与 usage analysis；
- usage/tool 的既有 ledger 暂保留在 `runtime/lib/benchmark/`，但 schema 语义已按 observability contract 扩展；
- SWE-bench dataset、evaluator、runner、multi-attempt 统计仍在 benchmark 层；
- 目录 pure-move 与 `benchmark-ledger` → `telemetry-ledger` rename 作为后续独立 PR，不与行为变化混合。

所有 telemetry 遵守：

- append-only / crash-safe；
- 只写 attribution、timestamp、count、token、封闭枚举；
- 不写 prompt、response、tool arguments、command、stdout/stderr、source、credential、receipt body 或 transcript；
- attribution 包含 `run_id`、`handoff_id`、`goal_id`、`lane`、`role`、`depth`、`turn`、`provider`、`model`；
- absent 与 0 可区分；
- reader 显式处理旧 schema。

## B-cache — prompt cache hit rate

公式：

```text
prompt_cache_hit_rate =
  sum(cache_read) /
  sum(input + cache_read + cache_write)
```

Suite report：

```ts
cache: {
  read: number;
  write: number;
  fresh_input_tokens: number;
  prompt_tokens: number;
  hit_rate: number | null;
  metrics_available: boolean;
  per_attempt_hit_rate: { median: number | null; p90: number | null };
}
```

规则：

- token-weighted，不平均各轮或各 attempt 百分比；
- provider 明确上报 0 是真实 0%；
- 未上报输出 null；
- 任一 attempt cache unavailable 时 suite availability false；
- per-attempt distribution 排除 unavailable attempt；
- 该指标不参与综合分数，只作为 prompt prefix 复用诊断。

## B3 — handoff terminal-state observability

数据源：

```text
cases/<instance>/attempts/<n>/codeflow-runs/<run-id>/handoffs/<handoff-id>/state.json
```

Runner 结束后 bounded scan，并原子写 canonical telemetry：

```text
cases/<instance>/attempts/<n>/telemetry/handoff-states.json
```

文件：

```ts
interface HandoffStateTelemetryFile {
  schema_version: 1;
  states: HandoffStateProjection[];
}
```

Projection 只允许：

```text
run_id
handoff_id
role
depth
status
result
goal_id
lane
blocked_reasons
unknown_blocked_reasons
retry_of
```

禁止输出 goal/scope/summary/detail/receipt/artifacts/evidence/prose。未知 blocked reason 计入 `unknown_blocked_reasons`，不静默丢弃。

Report 输出 total / PASS / FAIL / BLOCKED / nonterminal、blocked reasons、unknown reasons、redelegations，以及 by_role / by_lane 分解。旧 artifact 无 telemetry 时 `metrics_available=false`。

## B1 — source-clock timing + time-to-first-patch

### Tool timing contract

`DriverToolCall` 保留源时钟：

```ts
interface DriverToolCall {
  call_id: string;
  tool: string;
  status: "succeeded" | "failed" | "rejected" | "incomplete";
  requested_at?: string;
  result_at?: string | null;
}
```

Production driver 从 staging requested/result rows 取原始时间；incomplete call 只有 `requested_at`，`result_at=null`。Runner 写 canonical tool ledger 时不得用到达时间覆盖源时间。

并发工具调用按墙钟区间 merge，不按 duration 简单相加。

### Model round timing contract

`DriverRound` 保留：

```text
at: assistant response timestamp
request_started_at: provider request start boundary, nullable
depth
turn
```

Runner 写 usage ledger 时保留这些字段。provider 请求起点未观测时用前一终结事件推导，并显式命名 derived。

### Report 字段

```ts
wall_time: {
  total_seconds;
  median_seconds;
  p90_seconds;
  not_ranked: true;

  tool_execution_seconds: { total, median, p90 };
  provider_wait_derived_seconds: { total, median, p90 };
  local_overhead_derived_seconds: { total, median, p90 };
  time_to_first_patch_seconds: { median, p90 };
}
```

`provider_wait_derived_seconds` 与 `local_overhead_derived_seconds` 是 residual estimate，只用于同一环境前后对照，不用于跨环境排名。

### TTFP

TTFP 是 benchmark 语义，不属于 runtime telemetry。Runner 在事件边界检查 workspace，使用 `git status --porcelain --untracked-files=all`，因此同时覆盖 tracked 与 untracked changes；不能只用 `git diff --quiet`。

## B4 — waste attribution + context growth

Usage ledger 升级为 v2：

```ts
interface AttemptUsageRecord {
  schema_version: 2;
  at: string;
  request_started_at: string | null;
  attempt: number;
  run_id: string | null;
  role: string;
  provider: string;
  model: string;
  depth: number | null;
  turn: number | null;
  handoff_id: string | null;
  goal_id: string | null;
  lane: string | null;
  usage: { ...current token/cache fields... };
}
```

v1 rows 可读，缺失 attribution 规范化为 null，相关新指标 unavailable。

派生指标：

```text
rounds_in_non_pass_handoffs
tokens_in_non_pass_handoffs
waste_ratio_rounds
planner_rounds_ratio
handoff_reopens_per_goal_lane_median
first_turn_input_by_handoff_index
```

口径：

- non-PASS 由 canonical handoff terminal state 判定，不从 transcript 推断；
- planner ratio = depth-0 rounds / rounds with known depth；
- first turn 是同一 handoff 内最小 `turn`；
- starting context size = `input + cache_read`；
- cache 未上报时 context growth unavailable；
- zero-round handoff 仍计入 reopen 统计；
- suite aggregate 对所有 attempt 的 attribution availability 取严格口径。

## B2 — multiple attempts + dispersion

CLI：

```text
codeflow benchmark run --attempts N
```

默认 `N=1`。`N>1` 是 pilot / diagnostic，不代表正式 full-run 成绩。

每个 attempt 独立：

- workspace；
- Codeflow run；
- evaluation run id；
- budget state；
- prediction file；
- attempt ledger；
- handoff telemetry。

`case.json` 保存全部 attempts；`final_verdict` 口径：

1. 任一 attempt resolved → resolved；
2. 否则任一 unresolved → unresolved；
3. 否则任一 infra_error → infra_error；
4. 否则 not_evaluated。

共享 `predictions.jsonl` 仍严格保持 one line per instance：优先第一条 resolved attempt，否则 attempt 1。

Report：

```ts
attempts_per_instance: number;
not_official: boolean;
resolved: {
  pass_at_1_mean: number | null;
  pass_at_1_stderr: number | null;
  pass_at_n: number | null;
};
dispersion: {
  rounds_per_instance_cv_median: number | null;
  tokens_per_instance_cv_median: number | null;
  verdict_flip_rate: number | null;
} | null;
```

统计口径：

- pass@1 只以 resolved/unresolved 有效样本为分母；
- `infra_error` / `not_evaluated` 不进入 pass@1 分母，但仍保留在 counts；
- stderr 是 per-instance success rate 的 sample standard error；
- pass@N 是任一有效 attempt resolved 的 instance 比例；
- dispersion 仅 `attempts >= 2` 时非 null；
- verdict flip 使用该 instance 全部 attempt verdict 的集合大小。

## Schema / compatibility

| Artifact / stream | Version | Compatibility |
|---|---|---|
| manifest | v2 | report reader 兼容 v1，v1 视作 attempts=1 |
| case.json | v1 + additive metrics | 缺新 metrics 时 report 填 unavailable |
| model usage | v2 | v1 rows 可读，新 attribution 字段规范化为 null |
| tool execution | v1 字段不变 | DriverEvent 现在携带源 requested/result timestamps |
| handoff telemetry | v1 | 缺文件时 unavailable |
| report | v2 | v1 artifacts 可重建，新节点 unavailable |

## 验证

新增 / 扩展测试覆盖：

- prompt cache token weighting 与 unavailable；
- handoff metadata projection / prose 拒绝 / unknown reason；
- runner 写 canonical handoff telemetry；
- tool requested/result 源时间戳跨 production driver 保留；
- overlapping tool duration merge；
- tracked/untracked TTFP；
- usage schema v2 depth/turn/run attribution；
- v1 usage rows 兼容；
- non-PASS waste、planner ratio、reopen median、context growth；
- multiple attempt workspace / evaluation id 独立；
- pass@1 / pass@N / verdict flip / not_official；
- CLI `--attempts` 参数错误与 help。

标准 gate：

```text
bun run typecheck
bun test tests/benchmark
bun test
git diff --check
```
