# Design A — Codeflow 运行时效率优化

状态：待评审
基线：`main`（`1274ffd`，含 PR #6 execution-timeout→planner）
分支建议：`perf/runtime-efficiency`，按 A1 / A2 / A3 三个 PR 递进落地
度量依赖：Design B（benchmark 补强）的 B1/B3/B4 仪表盘；**建议 B 先合，A 的每个 PR 用 pilot 前后对照验证**

## 0. 目标与非目标

目标（按优先级）：

1. **token 质量与稳定性**：消除结构性重复注入，恢复 prompt cache 可命中性，降低单次瞬时故障导致整 run 报废的概率；
2. **轮数减少**：消除"机械性失败绕 planner 一整圈"的编排浪费；
3. **执行性能**：削减每 handoff 的固定进程冷启动开销与压缩链路延迟。

非目标：

- 不改变 handoff 状态机、封闭 reason 枚举、receipt 契约；
- 不引入任何对模型隐藏的注入（可见性契约不变）；
- 不为性能牺牲"业务命令永不隐式重试"的正确性原则（A3 中的重试全部是显式、事件流可见的）。

---

## PR A1 — 零行为变更（先落，纯收益）

### A1.1 context manifest 时间戳稳定化

**问题**：`codeflow-context/context.ts` 的 `buildContext` 在 XML 里写
`<context_manifest generated_at="${input.generatedAt}">`，每次注入必变。
这与 `handoff-gate.ts` 中 `delegationPointer` 特意固定 key 顺序保证
"byte-stable across turns" 的设计自相矛盾：同一 lane session 续用时，
历史消息中的注入 block 因时间戳不同而字节不稳定，破坏 provider prompt cache
前缀匹配，也破坏 transcript 可复现性。

**改动**：
- `ContextInput.generatedAt` 改为 run 级常量：取 `CODEFLOW_RUN_ID` 对应
  run 的创建时间（`state.json` 已有），或直接删除该属性、把真实注入时间挪进
  message 的 `details`（不进模型可见文本）。
- sources hash 机制不变（它本来就是内容 hash，天然稳定）。

**验收**：同一角色、同一规则内容、同一 facts 下两次 `buildContext` 输出
逐字节相等；现有 context 测试全绿。

### A1.2 扩展预打包为单入口

**问题**：`role-launcher.ts` 每次 spawn 子进程都挂 6 个 TS 源码扩展
（provider-profiles / agent-watchdog / codeflow-context / bash-compressor /
usage-ledger / host-guard），每个都要 Bun 即时转译；且 6 次 `fs.existsSync`
+ 6 个 `--extension` 参数。一次中型 run 几十个 handoff，冷启动开销 × N。

**改动**：
- 新增安装期构建步骤（`scripts/build-extensions.ts`）：把 6 个扩展
  bundle 成 `runtime/dist/role-extensions.js` 单入口（一个 default export
  依序调用各扩展的 register 函数）。
- `role-launcher.ts`：优先探测 `dist/role-extensions.js`，存在则单个
  `--extension`；不存在回退现状（开发态不需要 build）。
- zipper 子进程（`bash-compressor/index.ts` 中 `runZipper`）同样受益：
  它目前挂 `provider-profiles/index.ts` 源码路径。

**验收**：bundle 与源码两种路径下全部现有测试通过；新增微基准脚本
（见 A1.5）记录 spawn→first-event 耗时，bundle 路径应有可测下降。

**风险**：bundle 陈旧（源码改了没重建）。缓解：bundle 头部嵌入源文件
内容 hash，`role-launcher` 比对不符则回退源码路径并 stderr 告警。

### A1.3 常量去重

`MAX_CONCURRENCY = 8` 在 `codeflow-task/registry.ts` 与
`codeflow-task/index.ts` 各定义一次（registry 中的实际未使用）。
删 registry 侧，index 侧导出。

### A1.4 title-compressor 死配置处理

`roles.json` 定义了 `title-compressor`（mimo-v2.5-pro），
`references/roles.md` 也列出，但 runtime 无任何调用点。
**建议删除**（roles.json 条目 + roles.md 行）：接通它会增加 support 轮数，
与本设计方向相反；将来需要时从 git 历史恢复。

### A1.5 微基准回归脚本（配套仪表）

新增 `scripts/bench-local.ts`，不依赖模型/网络，输出 JSON：

- `spawn_cold_start_ms`：spawn 一个 no-op 角色子进程（`--no-session`、
  假 provider 立即退出）到收到首个 stdout event 的耗时，P50/P95 × 10 次；
- `context_block_bytes`：对固定 fixture 调 `buildContext`，输出字节数；
- `precompress_ratio`（A2.2 落地后）：fixture 日志集的确定性预压缩率。

用途：A1/A2 每个改动前后跑一次，写进 PR 描述；日常迭代不必碰 SWE-bench。

---

## PR A2 — 上下文增量注入 + 压缩链路（核心 token 优化）

### A2.1 lane session 续用时的增量注入

**问题**：goal lane session 跨 handoff 持久（`--session-id` 复用），但每个
handoff 都是新 pi 进程，`before_agent_start` 每次注入完整 XML block：
project AGENTS.md + shared AGENTS.md（约 7KB）+ 全量 fact ledger。
同一 lane 第 N 个 handoff 的 session 历史里躺着 N−1 份几乎相同的规则文本，
并且作为历史消息在之后每一轮持续计入 input token。facts 越攒越多时
每份快照还在变大。这是当前最大的结构性 token 浪费。

**机制**：注入消息已带 `details.sources`（kind/ref/hash）。续用 session 时：

1. `codeflow-context/index.ts` 在 `before_agent_start` 读取当前 session
   的既有 entries（pi session 文件可定位：`--session-dir` + `--session-id`
   已由 role-launcher 传入），找到最近一条 `codeflow:context` 消息的
   `details.sources`；
2. 对每个 source 按 hash 比对：
   - `project_rules` / `shared_rules` / `context_import` 未变 →
     不重复注入正文，manifest 写
     `<source kind="..." ref="..." hash="..." unchanged="true" />`；
   - facts：ledger 追加不可变（append-only、supersede 不改历史），
     注入上次快照之后**新增/新 supersede 的行**，节区改名
     `<shared_facts_delta since_hash="...">`；上次快照里被 supersede 的
     fact 通过 delta 里的 superseding 记录自然失效；
3. 新 session（lane 首个 handoff、或 architect/verify 无 session 的
   `--no-session` 路径）行为完全不变——全量注入。

**兜底**：定位既有 entries 失败（session 文件缺失、解析异常）→ 全量注入。
增量是优化，不是正确性依赖。

**可见性契约**：delta 消息依旧 `display: true`；人在 transcript 里看到的
是"上次之后新增了什么"，与审计目标一致。

**验收**：
- 单测：同 hash 不重复注入正文；hash 变更（AGENTS.md 被改）→ 该 source
  全量重注；facts delta 只含新行；损坏 session → 回退全量；
- 集成：模拟一条 lane 连续 3 个 handoff，第 2、3 个的注入 block 字节数
  显著小于第 1 个（配合 B4 的 per-handoff input 曲线做真实验证）。

**风险**：模型对"规则在很早的历史消息里"的遵循度可能弱于"规则刚刚重申"。
缓解：delta 注入保留一行指针（"rules unchanged, see the context block at
the start of this session"）；若 pilot 显示行为退化，规则层可配置
`CODEFLOW_CONTEXT_DELTA=off` 单独关闭。

### A2.2 zipper 前置确定性预压缩 + 缓存

**问题**：bash 输出 >16KB 即 spawn 完整 pi 子进程调 DeepSeek 压缩
（20s 超时上限）。跑测试套件的场景高频触发；每次都是一次 support round
+ 一次进程冷启动 + 一次网络往返。

**改动**（`bash-compressor/compressor.ts`，全部确定性、可单测）：

1. **预压缩管道**，在调 zipper 之前执行：
   - 连续重复行折叠（`× N` 计数）；
   - 测试框架感知裁剪：识别 bun test / vitest / jest / pytest 的
     摘要行与失败块，保留失败详情 + 摘要，折叠通过用例列表；
   - 堆栈折叠：同一异常的重复帧、node_modules 帧折叠；
   - ANSI 转义与进度条行剥离。
   预压缩后 ≤ threshold（16KB）→ **直接返回，不调 zipper**；
   仍超 → 把预压缩结果（而非原文）交给 zipper，缩短其输入。
2. **结果缓存**：以原始输出的 sha256 为 key 的 run 内 LRU（进程内存，
   容量 ~64 条）。重复执行同一命令（角色重试、多角色跑同一测试）直接命中。

**验收**：fixture 日志集（bun test 全绿 / 部分失败 / pytest / 纯重复行）
上的预压缩率断言；缓存命中不产生第二次 zipper 调用；压缩失败照旧返回原文
（现有安全性质保持）。

**预期效果**：zipper 调用次数（= support rounds 的主要来源之一）显著下降；
B 报告中 `support_model_rounds` 与 by_role=zipper 的分解可直接验证。

---

## PR A3 — 策略层改动（行为有变化，逐条可独立取舍）

> A3 每条都触碰"无重试"哲学的边界，措辞上的原则是：**被禁止的是
> 隐式重试**（隐藏在同一 handoff 内、事件流不可见、掩盖第一次失败）；
> A3 引入的都是**显式、有记录、有次数上限**的恢复动作。

### A3.1 机械性 finish 失败允许一次进程内修复

**问题**：子角色业务工作全部完成，仅 `handoff finish` 被 CLI 拒绝
（receipt JSON 不合法 / fact path 不存在 / artifact 为空）时，当前路径是：
子进程退出 → reconcile 记 `DELEGATION_ARTIFACT_MISSING` → planner 读
pointer、决策、重开 handoff → 新子进程全套冷启动 + 重新做完全部工作。
一次格式错误的代价是整个 handoff 的 token × 2。

**改动**：CLI 的校验拒绝本来就会把具体原因返回给子角色的当前 turn
（`code-agent handoff finish` 非零退出 + stderr 说明）。契约层面明确：
**校验拒绝不是终态**，子角色可以修复 receipt 文件后再次调用 finish——
这已经在同一进程、同一 handoff 内，不需要 runtime 改动，需要的是：

- `runtime/AGENTS.md` 与各 capability prompt 明确"CLI 校验拒绝 →
  修复后重试 finish 一次；第二次仍被拒 → 停止并如实退出"；
- `handoff finish` CLI 在拒绝时输出结构化的可修复原因（现有 CliError
  文本已较精确，补齐即可）；
- 事件流增加可选 `finish_rejected` 记录（kind 枚举扩一项），使修复行为
  可审计。

**不改**：业务命令失败、测试失败、EXECUTION_TIMEOUT 的处理完全不变。

### A3.2 零产出 PROVIDER_FAILURE 的一次显式重派

**问题**：provider 一次瞬时 transport/overload 故障 = 子 handoff BLOCKED
→ planner 按契约"Provider or Codeflow runtime failure is terminal for the
run" 关根 → 整 run 报废，已烧 token 全部作废，等人工 resume。
对 benchmark 就是一个 `infra_error`。

**改动**（在委派层 `codeflow-task/index.ts` 的 task 工具内）：

- 条件全部满足才触发：reasons 恰为 `[PROVIDER_FAILURE]`（无伴随
  truncation/artifact-missing 之外的业务信号）、子角色**零助手产出**
  （`finalText` 为空且无任何 tool call 发生——从 stopReason 与 stdout
  事件判定）、该 handoff 是本 (goal, lane, 原 handoff) 的首次尝试；
- 动作：自动开一个**新 handoff**（新 id，`retry_of: <原id>` 记入 state），
  原 handoff 保持 BLOCKED 终态不可变，事件流出现两条 `handoff_opened`；
  等待≥5s 退避后重派同 prompt、同 session 参数；
- 上限：每 (goal, lane) 每 run 一次；第二次失败原样上抛 planner；
- 开关：`CODEFLOW_PROVIDER_RETRY=off` 禁用（benchmark 对照用）。

**对既有文档的修订**：planner prompt 中 "Provider failure is terminal"
改为 "a provider failure that survives the delegation layer's single
recorded redelegation is terminal"；SKILL.md 观察者语义不变（它看到的
仍是事件流里的显式 handoff）。

**验收**：B3 的 blocked-reason 分布中 PROVIDER_FAILURE 终态占比下降、
`retry_of` 命中率可统计；注入假 provider 故障的确定性测试覆盖
"零产出才重试 / 有产出不重试 / 只重试一次"。

### A3.3 首 token 超时与流中 idle 分层

**问题**：`agent-watchdog` 的 stream-idle 统一 900s。真挂死的请求
（连首 token 都没有）也要等 15 分钟。

**改动**：`STREAM_IDLE_TIMEOUT_MS` 拆两档：
- `CODEFLOW_FIRST_EVENT_TIMEOUT_MS`（默认 180s）：本次 provider 请求
  发出后到首个真实 `message_update` 之前适用；
- 首 token 之后回到现有 900s 流中 idle 窗口（长推理合法）。
watchdog 已有 per-tick 检查结构，只需在请求边界记录"是否已见首事件"。

**验收**：现有 watchdog 测试 + 两档超时的边界测试；B1 的
provider_latency 分解验证长尾缩短。

### A3.4 planner 并行提示

`references/capabilities/planning.md` 增补一段：多个可独立验收的 goal
存在时，用 `task_group` 并行开各 goal 的 test lane（互不依赖）；
单 goal 内保持现状（one active handoff per lane 不变）。
纯 prompt 改动，无 runtime 变更。

---

## 落地顺序与验证矩阵

| 顺序 | PR | 前置 | 验证手段 |
|---|---|---|---|
| 1 | Design B（另一文档） | — | 自身测试 |
| 2 | A1 | — | 微基准 A1.5 + 全量测试 |
| 3 | A2 | B 合入（用 B4 曲线对照） | pilot 前后对照：input token 曲线、support rounds |
| 4 | A3.1 / A3.3 | B3 | pilot：DELEGATION_ARTIFACT_MISSING 与超时长尾 |
| 5 | A3.2 | B3，团队确认哲学边界 | 注入故障测试 + infra_error 率 |
| 6 | A3.4 | — | pilot wall time |

全部改动遵守仓库既有验收：`bun test`、`bun run typecheck`、
`git diff --check`、source safety。
