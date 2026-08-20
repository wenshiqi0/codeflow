# Design B — PR #7 benchmark 补强（直接落在 `codex/benchmark-support`）

状态：待评审
基线：PR #7（`922d93e`，feat: add SWE-bench Verified benchmark support）
定位：**报告层与 runner 层增量**，复用既有 usage / tool-call / handoff ledger，
不改执行协议、不改数据泄漏边界、不改官方 evaluator 权威地位。
原设计文档（docs/benchmark-design.md）的 §5 预算、§6/§7 计数口径、§9 判定分类全部保持。

## 0. 动机

PR #7 现有报告能回答"消耗了多少"（rounds/tokens/tool calls 及 per-resolved），
但不能回答优化工作需要的四个问题：

1. 时间花在哪（性能优化是否生效）——wall time 只有总量，无归因；
2. 结果稳不稳（方差多大）——每 instance 只跑一次，方差不可测；
3. 失败长什么样——`infra_error` 只是计数，codeflow 自己的封闭
   blocked-reason 枚举没有进报告；
4. 轮数/token 浪费在哪——没有"非 PASS handoff 消耗占比"“注入开销曲线"
   这类归因维度。

四个补强（B1–B4）对应四个问题。全部字段为**新增**，
`report.json` 的 `schema_version` 升为 2；既有字段不变，
`benchmark report` 对 v1 产物重建时新增字段输出 `null` 并带
availability 标记（沿用 §8 cache_metrics_available 的先例）。

## B1 — wall time 归因分解 + time-to-first-patch

**数据来源（全部已有）**：
- usage ledger（`usage.jsonl`）每行 `at` 时间戳 + role/depth 归属；
- tool-call ledger `requested`/`result` 行对：`result.at − requested.at`
  即该工具的执行时长；
- attempt 起止时间 runner 已记录（`wall_seconds`）。

**新增 per-attempt 字段**（`cases/<instance>/` 的 attempt metrics）：

```
wall_breakdown: {
  tool_execution_seconds,   // Σ (result.at − requested.at)，并发时按墙钟合并区间
  provider_seconds,         // Σ 相邻事件推得的模型等待窗口（见下）
  local_overhead_seconds,   // wall − tool_execution − provider（进程冷启动、编排）
  attribution: "derived"    // 明示为推导值，非 provider 上报
}
time_to_first_patch_seconds: number | null   // attempt 开始到工作区首次出现非空 git diff
```

`provider_seconds` 的推导口径：一个 model round 的等待窗口 =
该 round usage 行的 `at` 减去前一个终结事件（上一 tool result 或上一
usage 行）的 `at`，同 attempt 内求和。这是近似值，文档必须写明；
它的用途是**同一环境下前后对照**，不做跨环境比较。

`time_to_first_patch` 采集：runner 在轮询预算的同一循环里（已有
per-round 检查点）廉价执行 `git diff --quiet`，首次非零记录时间戳。
不新增进程外监控。

**报告层**：suite 级输出三段耗时与 TTFP 的 total/median/p90，
全部归入现有 `wall_time` 节并保持 `not_ranked: true`。

**测试**：fixture ledger（两工具重叠区间、无工具纯推理、零 round）
的区间合并断言；TTFP 在 fake driver 下的确定性注入。

## B2 — 多 attempt 与方差

**CLI**：`codeflow benchmark run --attempts N`（默认 1，行为不变）。

**runner**：
- 每个 attempt 独立：新 Codeflow run id、新工作区、新 evaluation run id
  （§4 的 run_id+instance_id 缓存键机制已支持，直接复用）；
- attempt 记录进同一 `cases/<instance>/`，`CaseAttemptRecord` 已是数组
  形态（PR 已有 attempts 结构），追加即可；
- `final_verdict` 口径：任一 attempt resolved → instance 计入
  `resolved_any`（等价 pass@N 的分子）；同时新增 `resolved_rate_mean`
  = 各 attempt resolved 率的均值（等价 pass@1 的无偏估计）。

**报告新增**：

```
attempts_per_instance: N
resolved: { pass_at_1_mean, pass_at_1_stderr, pass_at_n }
dispersion: {                      // 仅 N ≥ 2 时非 null
  rounds:  { per_instance_cv_median },   // 每 instance 跨 attempt 变异系数的中位数
  tokens:  { per_instance_cv_median },
  verdict_flip_rate                      // 同 instance 不同 attempt 结论不一致的比例
}
```

`verdict_flip_rate` 是"稳定性"最直接的单值指标。

**约束沿用原设计**：full 500 正式成绩仍以单 attempt 口径公布
（§4 "每个 instance 默认执行一次"不变）；多 attempt 是**迭代期
pilot 工具**，manifest 里 `attempts > 1` 时报告自动标注
`not_official: true`。

**测试**：fixture verdicts 构造 flip 场景断言 flip_rate；N=1 时
dispersion 为 null；不同 attempt 的 evaluation run id 互异（已有
hub-revision/predictions 测试模式可扩）。

## B3 — blocked-reason 分布

**数据来源**：run 的 handoff 终态。合规读取方式沿用外环契约——
只读 `state.json` 的枚举字段（`status`、`blocked.reasons`、`goal_id`、
`lane`、`role`、`retry_of` 若 Design A3.2 落地），**不读 body/receipt
prose**。benchmark runner 本来就拥有 run 目录（它创建的），
这不违反 §12 "不解析 session transcript"——handoff state 是
metadata plane。

**新增 per-attempt 字段**：

```
handoffs: {
  total, pass, fail, blocked,
  blocked_reasons: { PROVIDER_FAILURE: n, EXECUTION_TIMEOUT: n, ... },  // 封闭枚举
  redelegations: n          // retry_of 命中数（A3.2 未落地时恒 0）
}
```

**报告层**：suite 级按 reason 聚合 + 按 role/lane 分解。
`infra_error` attempt 与 PROVIDER_FAILURE 终态的关联在报告里并列展示，
用于区分"harness/Docker 故障"与"provider 故障"两类基础设施问题。

**测试**：fixture run 目录含各 reason 的 state.json，断言聚合；
含 prose 的 state 字段以外内容不被读取（复用 leakage.test.ts 的
拒读模式写一个 metadata-plane 合同测试）。

## B4 — 浪费归因与注入开销曲线

**数据来源**：usage ledger 已带 `handoff_id`/`goal_id`/`lane`/`role`/
`turn`/`input`；B3 提供各 handoff 终态。两者 join 即可，无新采集。

**新增 per-attempt 字段**：

```
waste: {
  rounds_in_non_pass_handoffs,           // 终态非 PASS 的 handoff 消耗的 rounds
  tokens_in_non_pass_handoffs,
  waste_ratio_rounds,                    // 上项 / model_rounds_total
  planner_rounds_ratio,                  // depth-0 rounds / total
  handoff_reopens_per_goal_lane_median   // 同 (goal,lane) 的 handoff 数 − 1 的中位数
}
context_growth: {
  // 同一 (goal,lane) session 内，第 k 个 handoff 首 turn 的 input token 序列
  // 报告聚合为：first_turn_input_by_handoff_index: [median_1, median_2, ...]
  first_turn_input_by_handoff_index: number[],
  metrics_available: boolean
}
```

`context_growth` 是 Design A2.1（增量注入）的直接验证仪表：
增量注入生效时该序列应从线性增长变为近平；
每个 handoff 的"首 turn"由 usage ledger 中该 handoff_id 的最小 `turn`
行确定，`input + cache_read` 之和为其起始上下文规模。

**测试**：构造 3-handoff 单 lane fixture ledger，断言序列与
waste_ratio；全 PASS run 的 waste 为 0；无 goal 归属行（planner）
正确进 planner_rounds_ratio。

## 落地顺序（同一 PR 内的 commit 切分）

1. B3（纯读 state.json + 报告聚合，独立性最强）
2. B1（ledger 时间戳推导 + runner 的 TTFP 探针）
3. B4（usage × handoff join）
4. B2（runner attempt 循环 + 报告方差节，改动面最大放最后）

每步独立可测、独立可 revert；schema_version 2 的迁移测试
（v1 产物重建 → 新字段 null + availability 标记）放在第 1 步一起进。

## 与原设计文档的一致性核对

- §5 预算不变，B2 的多 attempt 不影响预算语义（每 attempt 独立计）；
- §7 tool ledger 隐私白名单不变，B1 只用已有 `at` 字段；
- §9 正式 resolved rate 分母口径不变，pass@N 只在 attempts>1 的
  非正式报告出现；
- §12 非目标"不解析 session transcript"保持——B3/B4 只碰
  metadata plane（state.json 枚举 + usage/tool ledger）；
- 验收标准 §13 新增四条：B1 区间合并、B2 flip/独立 run id、
  B3 metadata-plane 合同、B4 序列与 waste 断言。
