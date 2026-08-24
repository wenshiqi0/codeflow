# Design G v3.1 — Split Economics & Delivery Obligations

状态：v3 终审通过（架构方向），本版补齐终审提出的四个边界，进入
实现前的最终文本；不含实现
基线：`final_goal_handoff_receipt_agent_runtime.md`（Final architecture
baseline）。遵守其全部十条 Invariants；本设计引入的全部代码与文案
须通过残留词汇锁（不含 depth / thread / acceptance_context / roles
残留）。

v3.1 相对 v3 的边界补齐：投影适用域（§4.4，child/非适用记录不再
误计 missing）；`met — <ref>` 交叉检查与指标命名收紧（§4.2）；
handoff_spawn 持久化后失败包络 + 现存 active marker 泄漏缺口
（§2.2/§2.3）；prompt 文件专门词汇测试（现有 architecture test 只
扫 `.ts/.json/.sh`，不覆盖 md）（§8）；实验按 (case, model,
replicate) 分层、因果对比写死为相邻差分（§9）；worker 文案补
"委派后 parent 仍负责等待与关闭"（§5）。

## 0. 证据基线（2026-08-24，django__django-11087 ×4 run）

| run | 模型 | verdict | rounds/tools | 组织工具 |
|---|---|---|---|---|
| main-session-030838 | Mimo v2.5 Pro | unresolved | 56/61 | 无 |
| deepseek-032000 | DeepSeek v4 Pro | infra_error | 52/53 | 无 |
| isolated-034500 | DeepSeek v4 Pro | unresolved | 37/45 | 无 |
| multiworker-052853（诉求强制指定拆分） | DeepSeek v4 Pro | unresolved | 90/104 | goal_create ×2、handoff_create ×2、worker_spawn ×2、recall ×2、receipt ×3 |

事实陈述（只陈述本样本支持的结论）：

1. **自发拆分率 0/3**：诉求不点名时，无一 run 使用组织工具；
2. 40+ 轮 solo run 从头到尾没有做过一次"是否拆分"的显式决策——
   不是评估后选择 solo，而是从未评估；该决策在 durable protocol
   中不可见，无审计抓手；
3. 强制拆分组消耗最多（90 rounds）且仍 unresolved——只能证明组织
   工具链可用、且当前委派成本高；**不能证明拆分改善质量**。拆分
   是否值得，是 §9 实验要回答的开放问题，不是本设计的前提。

关联失败样本：django-11087 的 solo 失败模式（在 `related_objects()`
调用点追加 `.only(related.field.name)` 的局部贪心补丁，漏掉下游
`to_field` 级联引用的字段、破坏 deletion signal 与 select_related
语义）同时暴露两类缺口：交付缺少可测试的义务约束（§4）；长轨迹
solo 无拆分决策（§2、§3、§5）。

## 1. 归因：solo 坍缩是当前结构的正解，不是偶然

四股力共同作用下的稳定均衡：

1. **prompt 中立 ≠ 行为中立。** 中立措辞的前提是模型先验中立；实际
   训练分布几乎全是单 agent 轨迹，solo 是极强默认先验。
2. **委派成本结构不对称。** 现状拆分 = `goal_create` →
   `handoff_create`（一整套契约写作）→ `worker_spawn`，三次调用加
   一次高成本上下文压缩；solo 的下一步永远只是再跑一条 bash。
3. **决策时机与信息错配（最本质）。** 拆分价值最高在任务早期，但
   彼时模型不知任务规模；数十轮后知道了，上下文已沉淀在私有窗口
   ——沉没上下文使拆分在每个时点都是局部劣选。动态不一致问题。
4. **触发信号不可感知。** Worker 对"已第 40 轮、上下文将满"零感知
   通道（context 仅在 `before_agent_start` 注入一次，§3 详述）。

**判别前提**：solo 本身不是缺陷（最终基线：root 与 unsplit 工作
使用 `goal_id = task_id` 是一等路径）。缺陷是"从未评估"与"决策
不可审计"。需要修的是长尾：solo 至上下文耗尽 / 后半程质量塌陷，
而拆分本可避免——该长尾是否真实存在，同样由 §9 数据判定。

## 2. 决策一：`handoff_spawn` 组合工具（结构层，第一优先）

### 2.1 语义

新增组合工具 `handoff_spawn`，一次调用完成"（可选）创建 child
Goal + 打开 Handoff + spawn Worker + 等待 execution terminal result"；
成功结果携带 Receipt，中断/启动失败结果不伪造 Receipt。不叫 `task`
（与 Runtime 顶层 Task 冲突）；无任何会话续接参数——每个 spawned
Worker 都是 fresh Pi context（最终基线 Context and Recall 节）。

```text
handoff_spawn(
  digest, intent, expected_outcome,          # 必填，同 handoff_create
  known?, references?, constraints?,
  evidence_requirement?,
  goal?: { id, objective, dependencies? },   # 可选：内联定义 child Goal
  goal_id?,                                  # 或复用既有 Goal；二者互斥
)                                            # 均缺省 → goal_id = task_id
```

既有三件套（goal_create / handoff_create / worker_spawn）保留——
`handoff_spawn` 是捷径不是替代；批量并发仍走 worker_group。

### 2.2 完整合同

- **校验失败**：goal 定义非法（同 id 已存在但内容不同、依赖成环）、goal 与 goal_id
  同时给出、Handoff 字段非法 → 整体拒绝，**零落盘**。零落盘的
  精确含义：无 Goal/Handoff 语义记录、**无任何 sequence claim
  （goal、semantic、event 三类逐项）、无 handoff event、无 active
  marker**——任何持久化副作用都不产生；
- **依赖门**：复用 `dependenciesCompleted`，未满足 → 按上款零落盘
  语义拒绝（G-T12）；
- **持久化后失败包络（本版收紧）**：Goal + Handoff 持久化成功后
  的**任何**异常——包括配置解析失败（resolveWorker）、OS spawn
  failure（进程无法创建）、launcher 内部错误——必须统一处理：
  1. Goal 与 Handoff 作为已持久化语义记录**保留**（append-only，
     Invariant 10，不可回滚）；
  2. **清理 active marker**（Handoff 回到可启动状态，不得卡
     "running"）；
  3. 记录 Runtime failure event（Invariant 7：不伪造 Receipt）。配置
     解析失败、OS spawn failure、launcher 在 execution 建立前的内部
     错误统一使用新增封闭枚举 `WORKER_LAUNCH_FAILURE`；进程成功启动后
     的 provider/execution 失败继续沿用现有 reason，不得误归 launch
     failure。`RUNTIME_FAILURE_REASONS` 与 `EVENT_REASONS` 必须同步扩展；
  4. 返回结构化**可重试**结果，携带 handoff_id；`worker_spawn`
     可重试该 Handoff。
- **spawn 中断**：child Worker 启动后被中断/崩溃 → 沿用既有
  Runtime failure 语义，返回 runtime_failure_reasons，Handoff
  可重启；
- **幂等**：`handoff_spawn` 本身不幂等（每次调用产生新 Handoff），
  与 handoff_create 一致；内联 Goal 沿用 `createGoal` 语义——同 id、同
  objective/dependencies 为幂等复用，同 id 异内容才是校验失败；防重复
  Handoff 依赖调用方语义，不加机械 dedupe。

### 2.3 现存缺口（实现 G1 时一并修复）

当前 `spawnWorker()` 中 `startHandoff()`（写 active marker）先于
`resolveWorker(CONFIG_FILE)` 执行（worker-launcher.ts）：配置解析
抛错即泄漏 active marker，Handoff 永久呈 "running"。这是现存
worker_spawn 路径的缺陷，不是 handoff_spawn 新引入的问题；§2.2
的失败包络对两条路径同时生效（G-T19）。

## 3. 决策二：run_facts 逐轮事实注入（感知层）

### 3.1 通道与来源

context 仅在 `before_agent_start` 注入一次，不提供中途感知。
run_facts 走 **provider-neutral 的 `context` hook**，每轮以
`ctx.getContextUsage()` 取当前估算值——不依赖 provider usage
返回时序（usage 在请求完成后才可得，"当前精确值"本就不存在）。

### 3.2 字段定义

- `execution_rounds_elapsed`：**当前 execution 内**已完成的
  assistant 轮次。命名显式绑定 execution：中断后重启的 Handoff
  是新 execution，从零计（fresh context 事实如此）；与"同一
  Handoff 跨 execution 累计轮次"是两个概念，本字段不承载后者；
- `context_utilization`：`{ value: number, basis: "pi_estimate" } |
  { basis: "unknown" }`。来源为 pi 的估算即标注 `pi_estimate`，
  不可得即 `unknown`；**不得伪装精确、不得省略字段**。

### 3.3 缓存影响

- run_facts 以**追加在消息序列尾部**的 ephemeral 事实块注入（每轮
  替换于尾部，稳定 append-only 前缀不动）——与最终基线 "Mutable
  reduced state follows the stable append-only prefix" 同一布局
  原则；
- 实现须在 §9 实验中报告注入前后 cache hit rate 与 prefix
  invalidation 对照；若代价显著，回调注入频率，字段语义不变。

`prefix invalidation` 口径锁定如下，避免实现时另造指标：在同一
execution 的每次模型请求前、注入 ephemeral run_facts 之前，取得
stable prefix 的规范化字节。除首个请求外，每次请求构成一次 eligible
transition；若当前 stable prefix 不以此前请求的 stable prefix
逐字节开头，则该 transition 计一次 invalidation。只持久化计数，不
持久化 prompt 内容：

```text
prefix_transition_count: number
prefix_invalidation_count: number
prefix_invalidation_rate:
  prefix_invalidation_count / prefix_transition_count
  | null  # transition_count == 0
```

attempt 级字段按上述公式计算；聚合级先求和两个 count 再相除，禁止
平均各 attempt 的 rate。provider 返回的 token cache hit rate 是独立
指标，不得反推或替代 prefix invalidation。

### 3.4 纪律

- 只给事实：数值与枚举，零指令、零阈值、零建议；
- 词汇锁：模板不含 should / prefer / consider / split（G-T5）；
- **同构锁定 schema 不锁字节**：字段集合与类型对所有 Worker 恒同。

## 4. 决策三：Delivery obligations（义务层）

### 4.1 定位

`runtime/AGENTS.md` 的 "Delivery obligations" 节目前仅存在于工作
树，未提交；且它是 **prompt 纪律，不是 Runtime 状态机**：
`submitReceipt` 对 completed 零语义数组不做校验，Runtime 不会也
不应把缺证据的 completed 自动降为 partial。

**强制层拍板：离线报告分类，永不是协议级拒绝。** 最终基线明确
"A Receipt is not a validation gate"；协议级拒绝即重新引入
PASS/FAIL Receipt gate。"缺证据的 completed 按 partial 统计"是
**报告侧分类规则**，AGENTS.md 文案须消除"Runtime 会降级"的误读
空间（G0a 内完成并提交）。

### 4.2 规范化义务记录与交叉检查

义务产出物落既有字段（证据文件进 `effects.file`、结论进
`established` 等，不新增协议字段），每项义务在 `decisions` 中
**必须**另有一条规范化行：

```text
obligation.regression:   met — <evidence ref> | exempt — <reason>
obligation.reproduction: met — <evidence ref> | exempt — <reason>
obligation.consumers:    met — <file:symbol, ...> | exempt — <reason>
```

- **适用集**：root Receipt 全部必含三行；child Receipt 中 status
  为 completed/partial 的必含三行；blocked/failed/superseded 不
  适用（无交付即无交付义务，投影见 §4.4）；
- **交叉检查（本版收紧）**：文法合法不等于履行——
  - `obligation.regression` / `obligation.reproduction` 的
    `<evidence ref>` 必须对应同一 Receipt `effects` 中的一条
    `{file}` 引用。用于义务校验的 `{file}` 必须是绝对路径；投影时对
    文件与 `RunPaths.evidence` 分别取 canonical realpath，文件必须是
    位于该 evidence 根内的普通文件。不存在、目录、路径穿越或 symlink
    escape 一律归 `malformed`；只做存在性与边界验证，不读取或泄露
    文件内容；
  - `obligation.consumers` 的 met 值必须匹配 `file:symbol` 逗号
    列表文法；
  - 任一检查不通过 → 该项归 `malformed`；
- **指标命名如实（比"二选一"再收一档）**：通过文法 + 交叉检查的
  记录，指标命名为 **verified declaration（可验证声明）**——存在
  的证据文件仍不证明测试真被运行；"义务履行率"这个名字本设计
  不使用。声明与事实的更深一致性留给 §9 的 resolved 率间接检验。

### 4.3 decomposition 留痕

所有 **root Receipt** 的 `decisions` 必须含且仅含一条：

```text
decomposition: split | solo — <reason>
```

- 无 not_applicable：调查任务同样可能拆分，逃生值破坏审计；无
  交付变更的调查任务照实写 solo；
- **mismatch 精确定义**：声明 `split` 但不存在任何
  `parent_handoff_id == root_handoff_id` 的 child Handoff →
  `decomposition_mismatch`；反之同理。判定锚点是 root Handoff 的
  直接子代，孙代 Handoff 不参与判定。

### 4.4 投影适用域（本版新增，防误计）

投影按适用集计算，非适用即 **`null`**，不落 missing：

| 记录 | 适用集 | 非适用投影 |
|---|---|---|
| decomposition | 仅 root Receipt | child 一律 `null` |
| obligation.* 三项 | root 全部；child 之 completed/partial | blocked/failed/superseded child → `null` |

- 四态 `met | exempt | missing | malformed` 只在适用集内取值；
  `missing` 的语义是"适用但缺行"，child 不再被误计；
- 报告侧分母 = 各记录的适用集（eligible summary），不是全部
  Handoff；
- 投影只输出枚举与 `null`，不泄露 reason/ref prose（保持
  projectHandoffState 不暴露 semantic prose 的既有纪律）；
- 义务行与 decomposition 行同属 `decisions` 行文法，**解析器
  同源复用**，不写两个。

## 5. 决策四：中途拆分的形式合法化（表达层）

`references/worker.md` 无 "Organization" 段；描述组织工具的是
第二段（"If organization tools are present, you may create Goals,
open Handoffs, and spawn Workers; their use is optional."）。在该
段以并列事实补充，且必须写明 parent 的收尾责任（防"转交即退出"
误读，本版收紧）：

> This includes handing off the remainder of an underway
> commitment; the delegating Worker still awaits the outcome and
> closes its own Handoff with a Receipt.

后半句与 worker.md 既有句 "Close the current Handoff exactly once
with a Receipt" 同义呼应，不引入新义务。措辞纪律：并列陈述，无
偏好词。

## 6. 明确不做

- 不加轮次唠叨（"超过 N 轮应考虑拆分"）：唠叨版 cap，N 永远调不对；
- 不加拆分偏好词：简单任务上会制造仪式性拆分；
- 不设协议级义务 gate（§4.1 已拍板）；
- 不给 run_facts 附带任何解读或建议。

## 7. Implementation slices

| slice | 内容 | 依赖 | 状态 |
|---|---|---|---|
| G0a | AGENTS.md Delivery obligations：§4.1 降级语义澄清 + §4.2 规范化记录与交叉检查条款；**提交**（现仅工作树） | 无 | 文案待改并提交 |
| G0b | AGENTS.md decomposition 留痕条款（§4.3） | 无 | 待实现 |
| G1 | `handoff_spawn` 组合工具，含 §2.2 完整合同、`WORKER_LAUNCH_FAILURE` 枚举 + §2.3 active marker 泄漏修复（惠及 worker_spawn） | 无 | 待实现 |
| G2 | run_facts：context hook + getContextUsage、尾部布局、pi_estimate/unknown、cache 对照埋点 | 无 | 待实现 |
| G3 | worker.md 中途拆分 + parent 收尾责任补句（§5） | 无 | 待实现 |
| G4 | 观察面：四态投影 + 适用域 null + 交叉检查 + mismatch（解析器同源） | G0a,G0b | 待实现 |
| G5 | 报告面：自发拆分率、verified declaration 四态分布、rounds 分桶 resolved 率、cache 对照 | G2,G4 | 待实现 |
| G6 | **prompt 词汇测试**：现有 architecture test 只扫 `.ts/.json/.sh`，须为 `runtime/AGENTS.md` 与 `references/worker.md` 增加专门测试（残留词汇 + 偏好词 + 流程词） | 无 | 待实现 |

## 8. 测试点（锁定）

### G0a/G0b/G6 义务层与文案

| # | 断言 |
|---|---|
| G-T1 | AGENTS.md 含四条义务 + 三行规范化文法 + decomposition 条款；shared_rules 经 contentHash 进 context_manifest（回归锁） |
| G-T2 | 义务措辞零流程词（first/then/before you/step）；不含"Runtime 将降级"类状态迁移承诺 |
| G-T3 | `submitReceipt` 对 completed 零语义数组**仍不拒绝**；对 decisions 中任意/缺失/畸形义务行**均不拒绝**（义务非协议 gate 回归锁） |
| G-T20 | **prompt 词汇测试**（新文件，非 architecture.test.ts 扩扫描）：`runtime/AGENTS.md` 与 `references/worker.md` 不含 depth/thread/acceptance_context/roles 残留、不含 should-prefer 类偏好词于形式并列处、不含 first/then 流程词于义务节（大小写不敏感） |

### G2 run_facts

| # | 断言 |
|---|---|
| G-T4 | 每轮 run_facts 为当前值（context hook 路径）；execution_rounds_elapsed 为 execution-local；重启 Handoff 新 execution 从零计 |
| G-T5 | context_utilization 仅 `pi_estimate` / `unknown` 两种 basis，不省略字段；模板不含 should/prefer/consider/split |
| G-T6 | run_facts **schema** 对所有 Worker 恒同；不锁字节 |
| G-T7 | 注入位于稳定前缀之后；按 §3.3 定义产出 cache hit rate / prefix invalidation 字段与计数，fixture 精确断言分子、分母和 `null` 语义 |

### G1 handoff_spawn

| # | 断言 |
|---|---|
| G-T8 | happy path：一次调用产生 Goal（如内联）+ Handoff + Worker 执行 + Receipt 回流，产物与三件套 schema 等价 |
| G-T9 | 校验失败 → 拒绝且零落盘：无 Goal/Handoff 记录、**goal/semantic/event 三类 sequence claim 逐项为零**、无 event、无 active marker |
| G-T10 | 持久化后 spawn 失败：Goal/Handoff 保留，返回结构化可重试错误含 handoff_id，`worker_spawn` 可重试 |
| G-T11 | child Worker 中断 → 无 Receipt、runtime_failure_reasons 上报（Invariant 7 回归） |
| G-T12 | 依赖未完成 → 拒绝且零语义写入（同 G-T9 三类逐项断言） |
| G-T19 | **失败包络**：持久化后注入配置解析失败 / OS spawn failure → active marker 被清理（Handoff 非 "running"）、Runtime failure event 以 `WORKER_LAUNCH_FAILURE` 落盘、返回可重试结果；进程启动后的 provider failure 不误分类；同断言对既有 `worker_spawn` 路径生效（§2.3 缺口回归锁） |

### G3/G4 表达与观察面

| # | 断言 |
|---|---|
| G-T13 | worker.md 新句与既有陈述并列于组织工具段，含 parent 收尾责任半句，全文无偏好词 |
| G-T14 | 投影：适用集内四态枚举；**非适用记录为 `null` 不计 missing**（blocked child、decomposition 之 child 逐项断言）；不含 reason/ref prose |
| G-T15 | 文法解析：合法行 → met/exempt/split/solo；缺行 → missing；畸形行 → malformed（大小写、多行、重复行边界） |
| G-T21 | **交叉检查**：met ref 无对应 `effects.file` → malformed；对应但文件不存在、非普通文件、不在 `RunPaths.evidence` canonical 根内、路径穿越或 symlink escape → malformed；合法根内文件 → met；consumers 非 `file:symbol` 列表 → malformed |
| G-T16 | mismatch：以 `parent_handoff_id == root_handoff_id` 为锚；孙代 Handoff 不触发（精确性回归锁） |
| G-T17 | offline fixture：solo 路径（零 child Goal，decomposition: solo，三行义务齐备）全链路 PASS，不被新增注入/义务阻塞 |
| G-T18 | offline fixture：中途拆分路径（N 轮后 handoff_spawn 剩余工作，child receipt 回流，root 记录 split）全链路 PASS 且无 mismatch |

## 9. 对照实验

**统一观察面**：G4/G5 是实验测量基础设施，不是 treatment。H0–H3
全部运行同一版本的 G4 投影与 G5 报告代码，仅切换表中行为干预；禁止
用各组历史 checkout 自带的不同 schema 直接比较。若基线实现不能载入
G4/G5，则在所有组完成后对其 canonical Runtime artifacts 运行同一
版本的离线后处理。每个 attempt 的 manifest 必须记录 observation
schema version 与启用的 intervention flags，schema/version 不一致的
attempt 不进入组间统计。

| 组 | 构成 |
|---|---|
| H0 | 当前基线 |
| H0′ | 仅 G0b（留痕条款单独的行为效应） |
| H1 | G0b + G1 |
| H2 | G0b + G1 + G2 |
| H3 | G0a + G0b + G1 + G2 + G3（全量） |

- **分层**：按 `(case, model, replicate)` 分层，各组的 case 与
  模型分布相同——组间差异不被模型构成混淆；
- case：django-11087 ×3（锚点错位 + 长 solo 轨迹双重探针）+ 既有
  模板 case + 一个多模块复杂 case ×3；模型至少覆盖 Mimo v2.5 Pro
  与 DeepSeek v4 Pro（§0 显示 solo 坍缩跨模型存在）；
- 指标：resolved 率、自发拆分率（分母：诉求不点名的 run）、
  decomposition 与义务 verified declaration 四态分布、mismatch
  率、rounds 分桶 resolved 率、cache hit rate / prefix
  invalidation（G2 代价核算）；
- **因果口径（写死为相邻差分）**：
  - `H0′ − H0`：仅留痕条款的行为效应（最便宜干预）；
  - `H1 − H0′`：handoff_spawn 的边际效应；
  - `H2 − H1`：run_facts 的边际效应；
  - `H3 − H2`：G0a + G3 的**捆绑**边际效应——此差分读不出两者
    各自贡献；若显著且需归因，后补 H2+G0a 单臂，不预先扩矩阵；
  - 自发 split × resolved 只作为**相关性**报告（自选择偏差：难题
    更可能触发拆分），不进因果结论；强制拆分组不作质量论据；
- 判读：
  - 相邻差分均无提升且长 solo 分桶质量不差 → solo 坍缩不需要修，
    G1/G2 降级为体验优化，结论本身值回成本；
  - H2 自发拆分率仍 ≈ 0 但 decomposition valid-record rate 高
    （评估过、选择 solo）→
    结构已修复决策缺失，先验问题留给模型侧；
  - missing/malformed 率高 → 义务文法或措辞回调，回调表达不回调
    结构。

统一验收：`bun test`（含残留词汇锁 + G6 prompt 词汇测试）、
typecheck、`git diff --check`、source safety。

## 10. 设计原则（G v3.1）

```text
 1. 义务绑定 Receipt 与证据引用，不绑定路径；强制层是报告分类，永不是协议 gate；
 2. 义务履行与拆分决策以规范化文法留痕，投影为封闭枚举加 null 适用域，统计是文法与交叉检查判定，不是启发式；
 3. 枚举不设逃生值；声明经 effects 与 parent_handoff_id 交叉校验；指标如实命名为 verified declaration，不冒称履行；
 4. Worker 可逐轮感知自身运行事实；事实标注估算性质，不携带指令，schema 恒同，布局尊重 prefix cache；
 5. 委派的机械成本须与继续 solo 同量级；拒绝路径零落盘（三类 sequence claim 逐项），持久化后失败必清 active marker 且可重试；
 6. solo 是一等路径；拆分不被偏好；委派后 parent 仍负责等待与关闭自身 Handoff；因果只从相邻差分读取，自发样本只报相关性。
```
