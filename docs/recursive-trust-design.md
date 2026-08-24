# Design E v2 — 协同文档模型：handoff 语料库的可见性与召回

状态：待评审（v2 取代 v1 的 dossier 方案）
基线：`codex/hygiene-context-tester`（Design C 落地；Design D 正交待落地）
证据基线：astropy__astropy-7166（官方 resolved，115 rounds；tester 40 +
coder 40 双双全量重发现）
分支建议：`perf/collaboration-corpus`

## 0. 模型（v2 的核心修正）

v1 提出新造一个 dossier artifact 作为递推载体。v2 放弃它：**协同文档
已经存在，就是 handoff/receipt 语料库本身**。

组织类比精确成立：

- **planner = 人事 + 首席分析**。它"不干净"（独占 goal/task/task_group
  三个委派工具）是设计而非缺陷：delegation 是人事权的物质形式，必须
  集中在拥有最上层视野、知道任务复杂度的角色手里。其余角色保持干净
  （四原语 + code-agent CLI），这是每个"人员"的工作上下文；
- **每个人员的产物 = 它的 handoff 交付**：handoff.md 是委派文档，
  receipt 是交付文档，artifact 是副作用产物。这条链就是协同文档；
- **协同文档对所有人可见，但不强制阅读**：给 title 和索引辅助第一
  直觉理解，需要细节时按 id 召回。可见性是机械保证的（注入索引），
  阅读是角色的自由判断（召回是 pull 不是 push）。

7166 的重复发现在此模型下的病因：文档链每一环都在磁盘上，但
`runtime/AGENTS.md` 禁止 content-scan `.codeflow/runs/`，worker 启动时
只有自己的 prompt + facts——**协同文档存在但被锁在抽屉里**。要修的
不是新增文档，是可见性（索引注入）+ 召回（CLI 通道）+ 文档质量
（handoff 粒度与 receipt 结论密度）。

两公理不变：**freedom**（不编排流程、不加分诊、不设探索上限）；
**trust**（递推继承，下游从上游结论出发做增量，纠错走 superseding
fact 而非静默重查）。

## 1. 现状验证（代码层）

| 环节 | 现状 | 缺口 |
|---|---|---|
| 委派文档落盘 | `openHandoff` 写 `handoffs/<id>/handoff.md` | 无 |
| 标题 | `title.txt`（TITLE_BUDGET 单行）+ `titleFor()` 回退 goal | title 可选、经常缺失 |
| 索引查询 | `handoffList()` 已输出 id/role/status/result/title/scope | 只有 CLI，worker 不可见且被 AGENTS.md 禁读 |
| 正文召回 | `handoff body --id`（C3.3 已落地） | 无 receipt 召回通道 |
| 交付文档 | receipt.json + summary + facts | receipt 面向验证器（status/exit_code），不面向下一个同事；无 conclusions |
| 可见性 | 无任何注入；"Never content-scan `.codeflow/runs/`" | 全部 |

## 2. 改动

### E1 planner 契约：首席分析者 + 人事权合法化（prompt 层，继承 v1）

`references/capabilities/planning.md`：

1. **删除**（同 v1）："does not … perform specialist research before
   delegating"；Bounded orientation 的 5 次调用/5 分钟上限；Goals 段
   "leave files, symbols, wire mappings, command discovery … to
   specialists"；
2. **新增 Analysis 段**：planner 读 issue 与代码直到能写出主干问题、
   嫌疑文件与符号、缺陷→症状机理、期望行为变化、未决不确定性。分析
   深度自由裁量，停止条件是"继续读不再改变你要写的委派文档"。分析
   写进 handoff 正文——**handoff.md 就是分析文档**，不再另设载体；
3. **新增 Staffing 段**（把"不干净"写成原则）：
   > Delegation tools (goal / task / task_group) are yours alone by
   > design: staffing decisions belong to the role that holds the
   > top-level view and knows the task's complexity. Every handoff you
   > open is a collaboration document that outlives you — write it for
   > the colleague who reads it out of context, and give it a title
   > that lets everyone else grasp it at a glance.
4. Concise handoffs 段修订：删除 "Do not paste source … Aim below
   2,000 characters" 的一刀切，替换为粒度契约（见 E4）。

`SKILL.md` 同步删除 "Naming files to edit or tests to write pre-empts
the roles" 句。

### E2 索引注入：可见性的机械保证（runtime，改动一）

`codeflow-context` extension 新增 context source
`kind="handoff_index"`：

1. **内容**：本 run 全部 handoff 的单行索引，每行
   `<id> <role> <goal>/<lane> <status[:reason]> — <title> — <summary?>`
   （terminal handoff 带 finish summary；行宽 ≤160 字符，机械截断）；
2. **体量**：7166 量级（7 个 handoff）≈ 1KB；行数超过 40 时只保留
   全部 active + 最近 40 条 terminal（罕见路径，防长 run 膨胀）；
3. **delta**：参与 A2.1 的 hash/delta 机制——索引未变不重注入，新增
   handoff 只注入增量行；行文本 byte-stable（不含 age 等易变字段）；
4. **注入面**：所有角色（含 planner 续轮）。与 shared_facts 并列，
   `display: true`，manifest 记 hash。

索引给的是"第一直觉"：一眼知道同事们做了什么、各自结论一句话。
读不读细节是角色自己的判断。

### E3 召回通道（runtime，改动二）

1. `code-agent handoff receipt --id <id>`：打印 receipt 的**结构化
   字段**（status、summary、conclusions、changed_files、facts、
   artifacts 指针），有界输出；`handoff body --id` 已存在，二者构成
   完整召回对（委派文档 + 交付文档）；
2. `runtime/AGENTS.md` 的禁读条款增补 carve-out（与 C3.2 的 evidence
   log 同构）：
   > Colleague handoffs are retrievable — but only through
   > `code-agent handoff body/receipt --id` and the injected index,
   > never by reading run files directly.
   直接扫文件仍禁止：召回必须走有界 CLI，保住"run 目录不被自由
   scan"的边界；
3. C3.3 的 lane 续跑指针化与此天然协同：指针 prompt + 注入索引 +
   召回 CLI 三者拼出完整视图，session 里不再重复驻留正文。

### E4 粒度契约：handoff 尺寸与 receipt 结论密度（prompt 层）

**委派粒度**（planning.md）：

> One handoff = one outcome a colleague can finish in a single
> sitting. If your analysis suggests the receiver would need to stop
> midway, split the outcome before delegating, not after the budget
> forces you to. The handoff body carries your full analysis for THIS
> outcome: suspected files and symbols, the defect-to-symptom
> mechanism, and what remains uncertain — a colleague must be able to
> start working from the document alone.

（4,000 字符上限保留为机械顶；2,000 字符的"目标"删除——分析厚度由
planner 判断，v1 的教训是薄 handoff 逼出 30 轮重发现。）

**交付结论**（runtime/AGENTS.md，receipt 契约增补）：

> Your receipt is read by colleagues, not only by the validator. Add
> a `conclusions` field: 3–10 lines of what you established, decided,
> or ruled out — written for the next role to build on, not a work
> log. A receipt whose conclusions the next role cannot act on wastes
> the entire handoff.

receipt schema 加可选 `conclusions: string[]`（validator 只查有界：
每行 ≤200 字符、≤10 行；不强制存在，避免 fail-closed 误伤）。

### E5 信任契约（prompt 层，继承 v1，措辞对准索引/召回）

`runtime/AGENTS.md` 新增：

> ## Inherited work
> The injected handoff index is your colleagues' work at a glance;
> retrieve any entry's full document with `code-agent handoff
> body/receipt --id` when the title alone is not enough. Treat
> retrieved conclusions as true and build on them; do not re-derive
> what a colleague already established. Re-read a file before changing
> it — that verifies the present, it does not distrust the past. If an
> inherited conclusion is wrong, supersede it in your receipt and
> continue from the corrected picture.

角色 prompt 收敛（同 v1）：`implementation.md` "You own repository
discovery" → "Discovery is inherited: start from the delegating
handoff and the index; extend it only where they are silent"（六种
feedback mode 保留）；`testing.md` 增 "Start from the planner's
analysis in your handoff"。

### E6 轮次构成遥测（benchmark 层，继承 v1，口径微调）

轮次分类 `explore / inherited-read / edit / execute / ceremony /
recall`（新增 recall 类：handoff body/receipt/evidence log 调用）。
**重复发现率 = explore / (explore + inherited-read + recall)**。
分类器纯离线，driver-ledger 已有逐轮工具记录。

## 3. 测试点（锁定）

### prompt 契约（`tests/roles/capability-contract.test.ts` 增补）

| # | 断言 |
|---|---|
| E-T1 | planning.md：旧三句消失（research 禁令 / five calls / leave files）；含 "You own the analysis"、Staffing 段关键句、粒度契约句 "one outcome a colleague can finish" |
| E-T2 | planning.md 不含 "Aim below 2,000 characters"；4,000 机械顶仍在 codeflow-task/index.ts（常量断言） |
| E-T3 | SKILL.md 不含 "pre-empts the roles" |
| E-T4 | runtime/AGENTS.md：含 "Inherited work" 段、conclusions 契约句、召回 carve-out；禁 scan 原则句仍在（两者共存） |
| E-T5 | implementation.md 不含 "You own repository discovery" 原句、含 "Discovery is inherited"；六 mode 关键词回归锁 |
| E-T6 | testing.md 含 "Start from the planner's analysis" |

### E2 索引注入（`tests/context/` 增补）

| # | 断言 |
|---|---|
| E-T7 | 3 个 handoff（1 active 2 terminal）→ 注入块含 3 行索引，行含 id/role/lane/status/title；terminal 行含 finish summary |
| E-T8 | 行 byte-stable：同状态两次构建逐字节相等（不含 age/时间戳）；行宽 >160 → 机械截断 + 省略号 |
| E-T9 | 索引未变 → A2.1 delta 下 manifest unchanged、正文不重注入；新增 1 个 handoff → 只注入增量行 |
| E-T10 | 41+ terminal handoffs → 全部 active + 最近 40 条 terminal，头部标注省略数 |
| E-T11 | 无任何 handoff（首轮 planner）→ 无 handoff_index source，不产出空 section |
| E-T12 | title.txt 缺失 → 回退 goal 截断（沿 titleFor 既有语义，回归锁） |

### E3 召回（`tests/handoff/` 增补）

| # | 断言 |
|---|---|
| E-T13 | `handoff receipt --id`：输出恰含结构化字段（status/summary/conclusions/facts/artifacts），不含 receipt 之外的 run 文件内容；未知 id → 非零退出单行错误 |
| E-T14 | receipt 无 conclusions 字段 → 正常输出其余字段（可选性回归） |
| E-T15 | `handoff body --id` 与 receipt 召回对同一 id 可组合使用（冒烟：委派+交付双文档完整取回） |

### E4 receipt 契约（`tests/handoff/` 增补）

| # | 断言 |
|---|---|
| E-T16 | conclusions 合法（≤10 行、每行 ≤200 字符）→ finish 通过；11 行或单行 201 字符 → CLI 拒绝且 handoff 保持非终态（沿 A3.1 修复语义） |
| E-T17 | conclusions 缺失 → finish 照常通过（不 fail-closed） |

### E6 分类器（`tests/benchmark/round-taxonomy.test.ts`）

| # | 断言 |
|---|---|
| E-T18 | fixture 轮次各归对类；recall 类识别 body/receipt/evidence log 三种调用 |
| E-T19 | 重复发现率：全 inherited-read → 0；全 explore → 1；混合按比 |
| E-T20 | 旧 run ledger（无索引数据）→ 降级四类不报错 |

## 4. 反教条检查

- 无任何任务分诊或流程分支；planner 分析深度、worker 是否召回，全部
  是角色自由判断；
- 不新增轮次/探索上限（C4 cap 维持安全网地位）；
- 索引注入是给可见性，不是给指令；召回是 pull；
- planner 独占委派工具被明文化为设计原则，而非被"清洗"。

## 5. 验收与对照

| 指标 | 7166 基线 | 目标 | 来源 |
|---|---|---|---|
| 总轮次 | 115 | ≤55 | E6 |
| 重复发现率（tester/coder） | 未测（估 >60%） | <20% | E6 |
| planner rounds | 9 | 15–30（分析前移，设计意图） | B4 |
| tester+coder rounds | 80 | ≤35 | B4 |
| 索引注入体量 | — | ≤2KB/轮（delta 后 ≈0） | E-T9 |
| recall 调用数 | 0（通道不存在） | >0 且 explore 相应下降 | E6 |

对照实验：

1. 7166 复跑 ×3（E 全开 vs 基线）：总轮次、重复发现率、recall 使用、
   官方 verdict；
2. 14539 模板轨迹 ×3：防退化；
3. 复杂多 goal case ×1：递推收益应随复杂度放大（分析一次、N 角色
   继承）；若数据相反，推翻本设计而非修补。

统一验收：`bun test`、`bun run typecheck`、`git diff --check`、
source safety、capability-contract 关键句锁。

## 6. 与其他设计的关系

- **取代 v1 dossier**：不新造 artifact；递推载体 = handoff/receipt
  语料库 + 索引 + 召回。少一个文档类型、少一个 CLI 面、少一套并发
  append 语义，且 handoff 粒度被迫变好（它现在就是协同文档本身）；
- Design D 正交（D1 预算、D2 eviction、D5 fingerprint、D6 遥测可
  并行落地）；D2 与 E2 有一处协同：eviction 外置旧 tool result 后，
  索引 + 召回恰好补上"旧信息如何回来"的通路；
- Design C 全部保留；C3.3 指针化从"省 token 的手段"升级为协同文档
  模型的组成部分。
