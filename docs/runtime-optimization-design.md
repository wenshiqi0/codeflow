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

**问题**：原实现中 `codeflow-context/context.ts` 的 `buildContext` 在 XML 里写
`<context_manifest generated_at="${input.generatedAt}">`，每次注入必变。
这与 `handoff-gate.ts` 中 `delegationPointer` 特意固定 key 顺序保证
"byte-stable across turns" 的设计自相矛盾：同一 lane session 续用时，
历史消息中的注入 block 因时间戳不同而字节不稳定，破坏 provider prompt cache
前缀匹配，也破坏 transcript 可复现性。

**改动**：
- 删除 `ContextInput.generatedAt` 与 `<context_manifest generated_at="...">`；
  真实注入时间写入 context message 的 `details.generatedAt`（不进模型可见文本）。
- sources hash 机制不变（它本来就是内容 hash，天然稳定）。

**验收**：同一角色、同一规则内容、同一 facts 下两次 `buildContext` 输出
逐字节相等；XML 中不再出现 `generated_at`，`details.generatedAt` 保留注入时间。

### A1.2 扩展预打包为单入口（明确不做）

**问题**：`role-launcher.ts` 每次 spawn 子进程都挂 6 个 TS 源码扩展
（provider-profiles / agent-watchdog / codeflow-context / bash-compressor /
usage-ledger / host-guard），每个都要 Bun 即时转译；且 6 次 `fs.existsSync`
+ 6 个 `--extension` 参数。一次中型 run 几十个 handoff，冷启动开销 × N。

**决策**：不做安装期 bundle，也不引入 `runtime/dist` 产物。保留 Bun
直接启动 TS 源码扩展的开发与部署路径。若为了秒级冷启动收益引入构建
步骤、stale bundle 校验和双路径回退，会持续增加双 loop 迭代成本，
也削弱源码可调试性；该 tradeoff 不成立。

### A1.3 常量去重

`MAX_CONCURRENCY = 8` 在 `codeflow-task/registry.ts` 与
`codeflow-task/index.ts` 各定义一次（registry 中的实际未使用）。
已删 registry 侧，index 侧导出。

### A1.4 title-compressor 死配置处理

`roles.json` 曾定义 `title-compressor`（mimo-v2.5-pro），但 runtime 无任何
调用点。已删除 roles.json 条目、role 文档行、capability prompt 与相关
测试引用；将来需要时从 git 历史恢复。

### A1.5 微基准回归脚本（暂缓，由独立 benchmark 承接）

暂不新增 `scripts/bench-local.ts`。运行时性能、token 曲线与 support rounds
由独立 benchmark 工作承接，避免在这里维护第二套度量口径。若后续局部
回归仍需要无模型微基准，再按原候选指标评估：

- `spawn_cold_start_ms`：spawn 一个 no-op 角色子进程（`--no-session`、
  假 provider 立即退出）到收到首个 stdout event 的耗时，P50/P95 × 10 次；
- `context_block_bytes`：对固定 fixture 调 `buildContext`，输出字节数；
- `precompress_ratio`（A2.2 落地后）：fixture 日志集的确定性预压缩率。

用途：仅作为未来局部诊断，不作为本 PR 的验收门槛。

---

## PR A2 — 上下文增量注入 + 压缩链路（核心 token 优化）

### A2.1 lane session 续用时的增量注入

**问题**：goal lane session 跨 handoff 持久（`--session-id` 复用），但每个
handoff 都是新 pi 进程，`before_agent_start` 每次注入完整 XML block：
project AGENTS.md + shared AGENTS.md（约 7KB）+ 全量 fact ledger。
同一 lane 第 N 个 handoff 的 session 历史里躺着 N−1 份几乎相同的规则文本，
并且作为历史消息在之后每一轮持续计入 input token。facts 越攒越多时
每份快照还在变大。这是当前最大的结构性 token 浪费。

**机制**：session 只有 `codeflow:context` 一种消息类型，不按 session 或
context 消息分版本；在现有 `details` 上扩展增量所需的机械 metadata，并把
静态规则与 fact ledger 分开处理。
增量是 append-only：不重写历史消息，也不在 provider 请求边界改写 payload；
从本次注入开始只避免继续制造重复。

1. **读取 active session context，不手解析 session 文件**。
   `before_agent_start` 的 extension context 已提供 `ctx.sessionManager`；
   调用 `buildContextEntries()`，从后向前找最近一条 active 的
   `custom_message` 且 `customType === "codeflow:context"`。这样跟随
   session branch/compaction 语义，避免把 abandoned branch 或旧文件格式
   误当作当前上下文。

2. **静态 source 用 hash 判断 unchanged / replace**。
   对 `project_rules`、`shared_rules`、`context_import`：
   - hash 未变 → 不重复注入正文，manifest 写
     `<source kind="..." ref="..." hash="..." unchanged="true" />`；
   - hash 变化 → 不做文本 diff，直接全量重注入该 source，manifest 写
     `previous_hash`、新 hash 与 `action="replace"`，并明确该正文取代
     早期同 ref 版本，避免新旧规则被拼接出歧义。

3. **facts 用 raw ledger cursor，不用渲染快照 hash 推断边界**。
   当前 `shared_facts` hash 只能说明 surviving view 变化，不能恢复上次
   读到哪里。context details 需要持久化：
   - `facts.from_cursor` / `facts.to_cursor`；
   - 可选 `from_record_id` / `to_record_id`（例如 `f7` → `f12`）。

   第一次 baseline 注入 raw event stream（含被 supersede 的历史记录），
   渲染时明确“later record supersedes the earlier record it names”；后续
   handoff 只注入 cursor 之后新增的 raw records。新的 supersede record
   天然失效早期 session 中的旧 fact，不需要重发全量 surviving view。
   若静态规则均未变且没有新增 facts，仍注入一个很小的 delta manifest，
   说明没有新 facts，保留可见性与增量 metadata。

4. **不做历史 session 兼容，也不引入第二类 context session**。lane 首个
   handoff，以及 architect/verify 等 `--no-session` 路径，仍做全量
   baseline 注入。后续增量继续使用同一种 `codeflow:context` custom
   message；没有旧格式迁移分支，也不因历史 session 选择不同消息类型。

**兜底**：以下情况一律 full injection，并在 details 记录
`mode="fallback"` 与 bounded reason：没有 `ctx.sessionManager`；active
entries 中找不到上一条 context；role/level 不匹配；source 或 facts
metadata 格式不合法；cursor 大于当前 ledger 长度；ledger ID 序列不连续；
`CODEFLOW_CONTEXT_DELTA=off`。增量是优化，不是正确性依赖，也不生成
兼容分支。

**可见性契约**：delta 消息依旧 `display: true`；人在 transcript 里看到的
是“上次之后新增了什么”。`details.generatedAt`、facts cursor 与 fallback
reason 均不进入模型可见 XML；模型只看到 manifest、replacement 正文和
facts delta。

**验收**：
- 单测：同 hash 不重复注入正文；hash 变更（AGENTS.md 被改）→ 该 source
  全量 replace 并携带 previous hash；facts delta 只含 cursor 后新增记录；
  supersede record 明确指向被替换事实；cursor 异常 / metadata 异常 /
  role 不匹配 → 回退全量；
- extension 测试：用 fake `ctx.sessionManager` 覆盖从
  `buildContextEntries()` 读取上一条 active context，且不读取 abandoned
  branch；
- 真实 Pi 冒烟：两个独立 Pi 进程复用同一 `--session-id/--session-dir`，
  第一轮持久化 full context message，第二轮从 active session entries 读取
  该 message 并输出 facts delta；
- 集成：模拟一条 lane 连续 3 个 handoff，第 1 个 full baseline，第 2 个
  facts delta，第 3 个 tiny delta / 新 facts；断言 facts cursor 单调推进、
  第 2、3 个注入 block 字节数显著小于第 1 个（配合 B4 的 per-handoff
  input 曲线做真实验证）。

**风险**：模型对"规则在很早的历史消息里"的遵循度可能弱于"规则刚刚重申"。
缓解：delta manifest 保留明确的 continuity 指针（"rules unchanged, see
the context block at the start of this session"）；若 pilot 显示行为退化，
`CODEFLOW_CONTEXT_DELTA=off` 可单独关闭。收益表述以 input token 与
context growth 下降为主，不把 prompt cache 命中率作为硬承诺。

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
> 当前只落地 A3.1 / A3.4 的 prompt 契约；A3.2 / A3.3 等 benchmark
> 证据后再决策。

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

- `runtime/AGENTS.md` 明确"CLI 校验拒绝 → 修复机械缺陷后重试 finish
  一次；第二次仍被拒 → 停止并如实退出"；
- `verify` / `supervisor` 不接收 shared rules，因此在各自 capability
  prompt 中补充同一契约；
- 不新增 `finish_rejected` event，不扩展 event kind / payload，也不做
  runtime 重试计数。第一次 CLI 错误留在当前 tool transcript 中，最终
  成功或失败仍由既有 handoff terminal event 审计。

**不改**：业务命令失败、测试失败、provider failure、EXECUTION_TIMEOUT
的处理完全不变。该条已按 prompt-only 方案落地。

### A3.2 零产出 PROVIDER_FAILURE 的一次显式重派

**状态**：暂不实现，等待 benchmark B3 的 blocked-reason / infra-error
证据后再决策。实现前还必须修正触发条件：零产出 provider failure 通常
同时缺少 receipt，实际 reason 组合是
`[PROVIDER_FAILURE, DELEGATION_ARTIFACT_MISSING]`，不是仅
`[PROVIDER_FAILURE]`。

**问题**：provider 一次瞬时 transport/overload 故障 = 子 handoff BLOCKED
→ planner 按契约"Provider or Codeflow runtime failure is terminal for the
run" 关根 → 整 run 报废，已烧 token 全部作废，等人工 resume。
对 benchmark 就是一个 `infra_error`。

**改动**（在委派层 `codeflow-task/index.ts` 的 task 工具内）：

- 条件全部满足才触发：reasons 恰为
  `[PROVIDER_FAILURE, DELEGATION_ARTIFACT_MISSING]`，且子角色**零助手
  产出**（没有任何 assistant text 或 tool call——从 stdout 事件判定）、
  无 truncation / execution timeout / user cancellation、该 handoff 不是
  retry、该 (goal, lane) 本 run 尚未使用 provider retry；
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

**状态**：暂不实现，等待 benchmark B1/B3 的延迟与失败分布后再决策。

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

`references/capabilities/planning.md` 已增补：只有多个确实独立、可分别
验收的 goal 成立时，才用 `task_group` 并行开启每个 goal 的**初始 test
lane**，且每个 goal 恰一个 tester handoff。不为并行而拆 goal；后续
code / verify lane 保持串行；共享文件、契约或存在顺序依赖的 goal 保持
串行。单 goal 内 one active handoff per lane 不变。纯 prompt 改动，
无 runtime 变更，已落地。

---

## 落地顺序与验证矩阵

| 顺序 | PR | 前置 | 验证手段 |
|---|---|---|---|
| 1 | Design B（另一文档） | — | 自身测试 |
| 2 | A1 | — | 全量测试 + 真实 Pi session 冒烟；性能指标交给独立 benchmark |
| 3 | A2 | B 合入（用 B4 曲线对照） | pilot 前后对照：input token 曲线、support rounds |
| 4 | A3.1 / A3.4 | — | prompt contract 测试 + pilot 观察机械性拒绝修复与 wall time |
| 5 | A3.2 / A3.3 | B1/B3 与团队确认哲学边界 | 等待 benchmark 证据后再实现 |

全部改动遵守仓库既有验收：`bun test`、`bun run typecheck`、
`git diff --check`、source safety。
