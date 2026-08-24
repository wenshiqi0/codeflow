# Design F v2 — Depth-Scoped Equal Workers（修订版）

状态：已评审定向，待实现
基线：`codex/collaboration-corpus-v3`（Design C + Design E v3 已实现）
证据基线：astropy__astropy-7166 有效 run（bench-20260822-194904-0efc，
官方 resolved、自然收尾、112 rounds）——E v3 全量落地后总轮次仅从 115
降到 112：协同语料、索引卡、召回全部就位而轮次不动，证明仪式下限是
**机械的**（lane join 强制每 goal 三次 PASS），prompt 层优化触碰不到。
这是本设计必要性的最硬证据。
分支建议：`codex/depth-scoped-equal-workers`
本版修订依据三条已拍板决策（v1 全文见分支历史）：

1. **goal 退化为任务分组**；
2. **对 round 和 token 不做任何机械 cap 限制**；
3. **提示词全面清理，且提示词中不出现任何 depth 词汇**——depth 只存在
   于代码层。

模型路由确认推迟为独立设计（后续会回到视野），本版全部 worker 固定
GLM-5.3，zipper 固定内部模型。

## 0. 结论（承 v1，不变）

Codeflow 不用"人员编制"建模。四概念解耦：

```text
organization capability -> depth（代码层 gating，prompt 不可见）
work methods            -> worker knowledge（中性目录）
model                   -> global worker default（路由推迟）
safety                  -> exact runtime/run-state boundary
```

没有 coordinator 身份。depth-0 worker 获得组织工具，可组织也可 solo。
所有 worker 平权：read/write/edit/bash + code-agent CLI + 协同召回。

## 1. 决策一：goal 退化为任务分组

### 1.1 语义

goal 从"带三 lane join 的验收契约"退化为**纯分组标签**：

- 保留：immutable id + goal 描述 + definition_of_done（**纯文档**，
  供人与 worker 阅读，不参与任何机械判定）；幂等重建校验保留；
- 删除：`GOAL_LANES`、`GoalLaneContract`、contract 的 `lanes` 字段、
  `goalView` 的 join 计算、`assertRootPassGoalJoins`（root PASS 不再
  被任何 join 阻塞）；
- `goalSessionId(runId, goalId, lane)` → `goalSessionId(runId, goalId,
  thread)`：thread 是委派方自由命名的会话标识（`[a-z0-9-]`），同名续
  session、新名 fresh。lane 枚举删除；
- `assertGoalLaneAvailable` → `assertThreadAvailable`：同 goal 同
  thread 单活跃 handoff（防同 session 并发写，机制语义不变）。

### 1.2 goal 剩下的两个真实职责

1. **协同语料的第一层目录**（E v3 已实现的 goal-scoped recall：worker
   在当前 goal 上下文查询 handoff 不需要传 goal id，跨 goal 显式
   `--goal-id`）——这是 goal 退化后仍然存在的全部理由之一；
2. **session 归属的命名空间**（thread 挂在 goal 下）。

`goalView` 退化为纯统计视图（per-goal handoff 计数、状态分布），供
观察面与 benchmark 报告使用，无任何判定语义。

### 1.3 root closure 语义

root PASS 的唯一机械要求回到 handoff 契约本身：非空 receipt +
artifact + summary（既有 finish 校验不变）。goal 是否"完成"由 depth-0
worker 在 root receipt 中陈述并对其负责——这与"没有 coordinator 身份、
组织工具的使用是可选的"一致：一个不创建任何 goal 的 solo run 本来
就没有 join 可言，有 goal 的 run 也不应例外。

**可观测性补偿**（记录事实，不设门）：receipt 机械追加一个推导字段
`acceptance_context: fresh | producer`——终态 PASS 的 handoff，其
session 是否产出过本 goal 的 changed_files。纯推导、零判断、不阻塞
任何转移。benchmark 报告按此分组统计 resolved 率；自验收与独立验收
的正确性差异从此是数据问题，不是哲学问题。若 20+ case 后两组无显著
差异，该字段降级为普通遥测；若有，再议是否需要机制（届时有据）。

## 2. 决策二：撤销一切 round/token 机械 cap

### 2.1 撤销清单

| 项 | 现状 | 处置 |
|---|---|---|
| C4.2 per-handoff round cap | usage-ledger 扩展在 `before_provider_request` 数轮、到 cap 发 BLOCKED + abort | **整体删除**（扩展中 cap 逻辑、`resolveHandoffRoundCap`、roles.json 全部 `handoff_round_cap` 键、`CODEFLOW_HANDOFF_ROUND_CAP` env） |
| D3 cap 预告 | 设计中未实现 | 作废 |
| benchmark `model_rounds` / `tool_calls` / `fresh_tokens` / `total_tokens` 预算轴 | 达标即停止推理、提取 patch | **全部降级为纯观测指标**：照常计量、进报告、参与对照，但不终止 attempt |
| benchmark `wall_seconds` | 5400s 安全停 | **唯一保留的终止轴**（基础设施安全，不是对模型的预算；挂死的 run 必须能死） |
| agent-watchdog（stream idle / bash timeout） | 900s / 15min | 保留——这是**活性**检测（区分挂死与工作中），不是预算 cap |
| evidence 12min per-command timeout | 保留 | 同上，单命令挂死检测 |

### 2.2 依据

7166 的 cap 数据：三条 lane 首个 handoff **全部**触发 cap——cap 已
不是异常保护而是常态检查点，每次触发硬 abort 丢掉当轮 receipt/facts，
制造 `DELEGATION_ARTIFACT_MISSING`，再逼出 split 仪式。cap 在扭曲
轨迹，不是在保护预算。

原则化：**收敛必须来自结构（协同语料召回 + solo path + 干净的工具
面），而不是来自断头台**。一个因为结构问题而漫游的 worker，被 cap
砍断只会把漫游成本变成"漫游成本 + 重启成本"。若实验中出现真失控
轨迹，那是结构缺陷的证据，修结构；wall_seconds 与 watchdog 兜底
基础设施安全。

### 2.3 连带修订

- Design D 的 D1（total 3M→9M）作废——不再有 token 终止轴，无所谓
  上限值；`cache_replay_dominated` 异常标记保留（观测有价值）；
- `budgetTerminatedBy` 只判 wall_seconds；既有预算测试改写为观测
  语义（照常累计、不触发终止）；
- 报告新增 per-attempt 全量消耗透明表（rounds/tool_calls/fresh/
  total/cache），排名与对照全部用观测值。

## 3. 决策三：prompt 全面清理，depth 不入 prompt

### 3.1 原则

depth 是**代码层机制**（组织工具在 `depth === 0` 注册，depth>0 不
注册），worker 对它的感知途径是**工具在不在工具集里**，而不是被
告知"你在什么位置"。prompt 中出现 "depth" 词汇即测试失败（F-T9）。

这比 v1 更干净：v1 的 §3.1 组织描述开头是 "This process is at
depth 0"——违反本决策，删除。

### 3.2 唯一的 worker prompt（全体 worker 逐字节相同）

`references/capabilities/worker.md`（替换全部身份 prompt）：

```md
# Worker

You are a Codeflow worker. The handoff you received defines your work:
outcome, context, boundaries, evidence. Your shared contract and the
collaboration corpus carry everything else you are entitled to know.

## Work methods

Methods for software work include: direct implementation;
diagnosis-first work; test-driven development; characterization before
change; scratch reproduction; benchmark-driven optimization;
investigation without change; implementation followed by self-review.
A worker may use, combine, adapt, or omit these according to the task.
Unless the handoff states a required deliverable or evidence form,
none is mandatory.

## Organization

Delegation tools, when present in your toolset, open handoffs to other
workers. Forms of software work include: direct completion; separated
specification, implementation, and evaluation; parallel ownership of
disjoint modules or invariants; implementation followed by review;
investigation before change. A handoff states its outcome, relevant
context, boundaries, and evidence. Other forms exist. Use of these
tools is optional.
```

要点：

- Organization 段以 "when present in your toolset" 为条件事实——同
  一份 prompt 对 depth-0 与 depth-1 都真（后者工具集里没有这些工具，
  该段自然空转），**prompt 不因位置而分叉**；
- 全文无 should/prefer/encourage/recommended/best（F-T10）；solo 与
  拆分是并列形式；
- planning.md / testing.md / implementation.md / verification.md /
  architecture.md / supervision.md 退役。其中的机械纪律（recorder
  用法、timeout 处置、nonzero-exit-is-FAIL、断言不弱化、receipt
  conclusions 契约）并入 `runtime/AGENTS.md`——它们本来就该是所有
  人的纪律；方法论内容改造为中性 work-method references
  （`references/work-methods/*.md`，只描述方法与常见证据形态，不
  声明身份、不推荐）。

### 3.3 registry

```json
{
  "roles": {
    "worker": {
      "description": "Peer executor; the handoff defines the work.",
      "model": "zhipuai-coding-plan/glm-5.3",
      "prompt": "references/capabilities/worker.md",
      "needs_project_rules": "shared"
    },
    "zipper": { "…": "internal，固定内部模型，不变" }
  }
}
```

- planner/tester/coder/verify/architect/supervisor 条目删除；
- `delegates` 权限键删除（组织工具注册只看 depth）；
- 无 `handoff_round_cap` 键（决策二）；
- role→model 映射消失；模型路由留待独立设计。

## 4. Host guard 精确化（承 v1 F1，不变）

保护 runtime source 与 run metadata（handoffs/goals/events/
pi-sessions/ledgers/state/receipt/secrets），允许
`CODEFLOW_PROJECT_DIR` 与 `CODEFLOW_EVIDENCE_DIR`；canonical path
判定，嵌套 benchmark workspace 不因位于 `.codeflow` 下而误拒。
7166 中 worker 被误伤只读后以 bash heredoc 绕过、削弱工具级审计的
问题由此修复。此项独立于平权论证成立，**最先落地**。

## 5. Implementation slices（修订）

| slice | 内容 | 依赖 |
|---|---|---|
| F1 host guard 精确化 | §4 | 无（纯 bug 修复，先行） |
| F2 cap 全撤 | §2 撤销清单 + benchmark 预算降级为观测 | 无 |
| F3 goal 退化 | §1 goals.ts 手术 + thread 化 + root closure 语义 + acceptance_context 推导字段 | 无 |
| F4 depth-gated 组织工具 | goal/task/task_group 注册条件 `depth === 0`；`delegates` 键退役；task 签名 `(prompt, goal_id?, thread?)`，`agent`/`lane` 参数删除 | F3 |
| F5 prompt 收缩 | worker.md + AGENTS.md 纪律合并 + work-method references + 身份 prompt 退役 + registry 收缩 | F4 |
| F6 观察面词汇迁移 | SKILL.md 角色词汇、B3/B4 报告 by_role → by_goal/by_thread/by_depth 分解 | F5 |

## 6. 测试点（锁定）

### F2 cap 撤销

| # | 断言 |
|---|---|
| F-T1 | usage-ledger 不再含 cap 逻辑：注入任意多 assistant usage 不产生 BLOCKED、不 abort（旧 round-cap 测试反转） |
| F-T2 | roles.json 无 `handoff_round_cap` 键；`CODEFLOW_HANDOFF_ROUND_CAP` 被忽略（读它的代码已删除，grep 级断言） |
| F-T3 | `budgetTerminatedBy`：rounds/tool_calls/fresh/total 任意超额 → null；仅 wall_seconds 超额 → `wall_seconds` |
| F-T4 | 预算超额的 attempt 照常提取 patch、提交 prediction、请求 verdict；报告消耗表含全部观测值 |
| F-T5 | watchdog stream-idle / bash timeout / evidence 12min 行为不变（活性检测回归锁） |

### F3 goal 退化

| # | 断言 |
|---|---|
| F-T6 | defineGoal 产出无 lanes 字段；definition_of_done 保留为纯文档；旧格式 contract 读取 → 明确 schema 错误（fail loud 无静默迁移） |
| F-T7 | root handoff finish PASS 在零 goal、有 goal 未"完成"两种情况下均不被 join 拒绝（assertRootPassGoalJoins 已删除） |
| F-T8 | 同 goal 同 thread 续 session；新 thread fresh；`assertThreadAvailable` 拒绝同 thread 并发 |
| F-T9a | goal-scoped recall（E v3）在退化后照常工作：当前 goal 查询免 goal id、跨 goal 显式 `--goal-id`（协同目录职责回归锁） |
| F-T9b | receipt 的 acceptance_context 推导：产出过 changed_files 的 session 终态 PASS → `producer`；否则 `fresh`；字段不阻塞任何转移 |

### F4/F5 depth 与 prompt

| # | 断言 |
|---|---|
| F-T10 | depth 0 注册 goal/task/task_group；depth 1 不注册；与 role label 无关 |
| F-T11 | depth 0 不用组织工具直接 finish root 是合法 PASS 路径 |
| F-T12 | task 签名无 `agent`/`lane` 参数（硬删非忽略）；`thread` 缺省 fresh |
| F-T13 | worker.md 对全部 worker 逐字节相同；全部 prompt 文件（worker.md、work-methods/*、AGENTS.md）不含 "depth"（大小写不敏感 grep） |
| F-T14 | 全部 prompt 不含 should/prefer/encourage/recommended/best；TDD 与 direct implementation 并列出现 |
| F-T15 | planning/testing/implementation/verification/architecture/supervision.md 不存在；AGENTS.md 含 recorder 用法、nonzero-exit-is-FAIL、断言不弱化（纪律平权化回归锁） |
| F-T16 | registry 恰含 worker/zipper；`resolveRole("tester")` → unknown role，错误消息列现役名单；`delegates` 键不被读取 |

### F1 host guard

| # | 断言 |
|---|---|
| F-T17 | `CODEFLOW_PROJECT_DIR` / `CODEFLOW_EVIDENCE_DIR` 下 write/edit 允许；runtime source 与 run metadata 写入拒绝 |
| F-T18 | 嵌套 benchmark workspace（位于 `.codeflow` 输出目录下）write/edit 允许（canonical path 判定） |

### 端到端

| # | 断言 |
|---|---|
| F-T19 | offline fixture：solo 路径（零 goal 零 task，depth-0 直接修复并 finish）全链路 PASS |
| F-T20 | offline fixture：组织路径（1 goal、2 thread、fresh 验收 handoff）PASS 且 acceptance_context=fresh 落 receipt |
| F-T21 | B3/B4 报告在无 role 数据下正常产出；分解维度 by_goal/by_thread 可用 |

## 7. 对照实验（2×2 拆分，隔离结构与语气两个变量）

| 组 | 结构 | prompt |
|---|---|---|
| G1 基线 | E v3 多角色 + lane join + cap | 现有身份 prompt |
| G2 | F 结构（depth + goal 退化 + 无 cap） | 现有身份 prompt 语气改写为可用的最小适配 |
| G3 | F 结构 | 全中立 worker.md |
| （G4 略） | 旧结构 + 中立 prompt 无意义，不跑 | — |

- case：7166 ×3 + 14539 ×3（模板防退化）+ 一个多模块复杂 case ×3
  （验证 depth-0 在真需要拆分时会用组织工具）；
- 指标：总轮次、handoff 数、官方 verdict、自然收尾率、patch 卫生、
  重复发现率（E6 分类器）、acceptance_context 分布 × resolved 率、
  全量消耗观测表；
- 判读：G2 vs G1 隔离结构收益；G3 vs G2 隔离中立化影响——若 G3
  劣于 G2，说明中立化过头（方法目录欠定），回调的是表达不是结构。

统一验收：`bun test`、`bun run typecheck`、`git diff --check`、
source safety、prompt 关键词锁（F-T13/14/15）。

## 8. 设计原则（v2 终版）

```text
 1. 没有 coordinator 身份；组织能力由 depth 决定，且 depth 只存在于代码层；
 2. prompt 不出现 depth、不出现角色身份、不出现偏好词；
 3. 单人工作是并列形式，不是退化形式；
 4. 所有 worker 平权、同 prompt、同工具面、同模型（路由另案）；
 5. 工作方法属于 worker；handoff 描述 outcome/context/boundary/evidence，不描述流程；
 6. goal 是任务分组 + 协同语料目录 + session 命名空间，无判定语义；
 7. 对 round 与 token 不设任何机械 cap；收敛来自结构，安全来自活性检测与 wall time；
 8. 自验收与独立验收作为事实被记录（acceptance_context），不作为门槛被强制；
 9. host guard 精确保护 runtime 与 run state，绝不误伤目标工作区；
10. zipper 是内部程序保障层。
```
