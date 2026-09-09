# Codeflow Collaboration Semantics

Status: **Normative — outer-led orchestration, shared codeteam**

本文档是模型可见协同语义的基线。更改对象、action、字段或状态必须同步修改本文档、
实现、提示词和契约测试。外层 loop 负责整体组织；Pi Agent 执行工程工作，也可调用 codeteam。

## 1. 对象与责任

持久工作语义使用 Goal、Commitment、Receipt、Agent。Task 是运行容器与根 Goal，
`goal_id = task_id`，没有合成默认 Goal。

- Goal 是稳定的结果边界，一对多、可再次分配。仅换人、重试或追加验证不复制 Goal。
- Agent 是执行主体。外层通过 `codeteam` 创建 Agent、分配工作、复用与恢复。
- Commitment 是执行者检查现实后自行声明的工作承诺，创建后不可修改。
- Receipt 记录该承诺的实际进展或结果，不是计划、transcript 或隐藏推理。

不设置 Root/Child 能力层级或独立 Manager 角色。`codeteam` 对外层与 Pi 提供相同入口，
本版本不专门禁止 Pi 创建或控制 Agent，也不设置派生深度限制。代码中的 `root`
进程/账本标签用于识别 standalone runner，不是模型管理角色。

## 2. 外层 codeteam

`start` 创建 Task/根 Goal 的元数据，不启动模型。`goal` 创建不同结果边界，可声明已存在
Goal 的依赖。`spawn` 为已有 Goal 异步启动执行者；外层同时继续自己的有效工作。
每次 assignment 有新 execution id，Agent id 在复用期间保持稳定。

`followup` 仅接收 idle Agent，在同一 Goal、仓库、模型下打开其显式 Pi session 文件，
追加新工作。这是真实会话上下文复用，不是仅沿用 Goal。独立评估需要新的 Agent，不能
把原 Agent 自检算成独立证据。没有运行中 steer、消息队列或隐式重试：busy 立即拒绝，
不排队、不等待模型。若当前工作边界不合适，外层判断独立扩展还是显式停止后恢复。

`resume` 仅适用于 interrupted 且所有进程已停止的 Agent。保留原来的开放 Commitment，
使用新 execution id、新 session 与持久记录/当前仓库重新建立上下文；不恢复失败会话。
没有 Claim 的失败可以重新检查并自行 Claim。已终结的 Commitment 不重新打开。

Agent 状态是 Runtime 元数据：`starting` 表示已预留，`running` 表示 runner 接手，
`idle` 表示执行结束且有真实终结报告，`interrupted` 表示异常或显式停止。idle 不是 Task
完成。并发容量在 Task 创建时确定，`CODEFLOW_MAX_CONCURRENT_AGENTS` 默认 8，
只计算已预留/正在执行/未确认停止的 Pi assignments，不包含外层模型或闲置 session。
同 Agent session 独占与 Task finish/spawn 使用同一个短元数据锁。容量满时立即拒绝；
元数据锁最多等待一秒，不等待模型；锁 owner 崩溃时失败关闭，不自动抢锁。

`status` / `inspect` / `watch` / `sub` / `usage` 提供观测。`watch` 是一个持续的只读
NDJSON 流，同一进程跨越 spawn、idle 和 followup，Task 收口或观察者取消时退出。
它输出原始派工 Goal/focus、Claim、进展 Receipt、上下文压力、状态变化和需要检查的信号；
不输出重复快照或逐次 usage。`--since` 控制事件重放，`--idle` 默认 300 秒，表示
逐 execution 的无活动观察窗口，不是执行时限。新 usage、状态或执行相关事件会静默
延长该 execution 的观察窗口；其他 Agent 的活动不会掩盖它的停滞。无活动、进程
身份异常或中断只产生去重 attention，不自动判定工作失败、关闭承诺、停止或重试。
取消监听不影响 Worker。usage 仅在模型响应结束后追加，长请求或工具运行可能没有
增量；必须区分“刚有活动”“进程仍存活”和“工作正确完成”。历史缺少归属的 usage
不猜测归属。`sub` 保留为有界历史/诊断读取，不再要求外层反复 sub + timeout。

宿主应保留一个异步监听句柄，在程序层处理空的传输等待，只把有意义的变化交回外层。
CLI 本身不保证能唤醒已经结束的宿主对话。观测不启动模型，也不读取 session、
transcript 或隐藏推理。事件投影除 enum/summary 外允许携带 Task/Goal/Agent/execution/
Commitment/Receipt 的受限标识符，便于直接 inspect；`context_pressure` 事件还投影经过
校验的用量估计、上下文窗口与触发阈值，不携带工具参数、输出或私有推理。

`stop` 先阻止该 execution 继续启动/被复用，再停止其记录的进程，保留开放 Commitment。
runner 死亡不直接表示工作安全停止；先 stop/reconcile，再显式 resume。PID 与启动身份
在首模型调用前核验。Pi 环境标识不阻止调用 codeteam；Runtime 文件保护仍然有效，
Claim 不作为工具权限门槛。这不是对同用户任意脚本的操作系统安全沙箱。bash 在执行命令前持久登记独立
进程组及 leader 启动身份，保留 keeper 到清理完成；记录不含命令、输出或环境变量。
Pi 正常退出、runner 发现 Pi 被强杀、外层 stop 都能核验并回收这些进程组。未确认清理
时保留占用并禁止复用/finish；不能假设自行 daemonize、逃离进程组的程序也被回收。

`finish` 是外层明确的 Task 结论，状态 `completed | blocked`，带 `summary` 和可选
`remaining`；completed 不允许 remaining，blocked 必须说明 remaining。必须所有 Agent
进程退出、所有 Commitment 终结后才能 finish；completed 还需至少一条真实 Agent 终态回执。
外层依据报告内容和证据验证整体结果、处理剩余工作，并解释已关闭 blocker 如何被解决/覆盖；
Agent 的终态标签不替代外层的 Task 结论。finish 写 Task 控制状态与
`run_finished` 事件，不伪造 Agent Receipt。Task 控制状态为 `open | completed | blocked`。
Agent 在根 Goal 写终结 Receipt 也不会自动关闭这个外层 Task。

新的 Runtime 事件是 `agent_assigned(STARTING)` 和
`agent_execution_finished(IDLE|INTERRUPTED)`。其有界投影字段可包含
agent_id、execution_id、goal_id、mode、resume_commitment_id、reasons、exit_code、summary；
Task 结束事件可带 orchestration=outer 与 remaining。完整状态在 Task/Agent 元数据；
这些不是要求 Pi 手填的协同字段。已有 Commitment/Receipt 事件仍沿用相同序号。

## 3. 分工与 Commitment

外层根据实际代码、Claims、新证据与报告持续判断可独立推进的边界。独立性可以来自不同
文件、消费者、解释、反例或验证问题。及时分派有价值的工作，同时推进本地关键路径；
不先做完再重复分派。并发写入边界不得重叠，不设置固定角色、人数或复杂度路由。

focus 说明问题/交付物、相关路径或记录 id、真实约束、共享写入边界；保持简洁连贯，
建议不超过 600 字，但不做硬长度限制。新 Agent 不继承外层对话。focus 不是预写的承诺，
也不是必须相信的技术结论；Agent 需要检验输入与现状冲突并报告异议。

派工响应回显实际 Goal/focus、Agent/execution、mode 和是否复用上下文，不把私有
session 路径当作提示词。外层在当前对话展示自己的初始 Goal/focus 原文，后续仅展示
新 focus 并引用不变 Goal；这不是完整 Pi system prompt 的转储。执行者在重要发现、
实现或验证节点写简短 progress Receipt，报告已发生的变化和剩余工作，不等最后才
暴露错误假设；不为刷新存活计时或重复 usage 而写回执。

Pi 的 Claim 字段仅有：

```text
work         必填；执行者拥有的工作边界
done_when    可选；可观察的完成条件
constraints  可选；真实约束
```

Agent 只需检查到足以建立可靠边界，不必先解决问题才 Claim。未验证的技术判断保持为
待验证问题，不提前写成封闭答案。精确输入/字段集合等边界需检查相关消费者与变体。
Agent 应检查后自行 Claim，以记录工作归属，不等外层审批。Claim 不是工具权限门槛：
Runtime 不因 Commitment 缺失、开放或终结而拦截 read、bash、edit、write；Runtime 文件
与运行元数据保护仍独立生效。外层可读其承诺并扩大覆盖，但不修改它。

一个 execution 一次只在一个 Goal 内工作；一个 Commitment 归属一个原始 execution，
恢复通过 Runtime 元数据绑定新进程，不重写承诺身份。正常工作可以终结旧 Commitment 后
在当前分配边界内自行 Claim 新的一块工作。codeteam 派工独立记录 Agent/execution；
新执行不继承调用者的 Commitment 或 session，派工也不会转移原承诺的责任。

## 4. Receipt 与 Pi 工具

所有 Pi Agents 的 `collaborate` action **只有 inspect、claim、report**。

- `inspect` 读当前/指定 Goal，或用 `commitment_id` / `receipt_id` 召回完整持久记录。
- `claim` 自行创建当前工作的 Commitment。
- `report` 汇报进展或终结。Claim 前仅允许 blocked execution report，不伪造 Commitment。

没有 `delegate`、`wait`、Goal 创建、Agent 消息或 followup action；这些不是 Receipt 协议。
Pi 可通过 bash 调用 `codeteam` 的工程、观察和控制命令，包括 spawn/followup/resume。
同一 Task 的派工共享容量限制，busy 仍拒绝复用；没有针对 Pi 身份的额外禁令。
Pi 正常结束后即退出，不保留内层父 Agent 等待反馈，也不自动唤醒模型。

Receipt 字段仅有：

```text
status     progress | completed | blocked
summary    必填；实际结果或阻塞
effects    可选；Git、文件、外部系统或服务的可观察引用
remaining  可选；未完成工作
```

progress 保持 Commitment 开放；completed 与 blocked 终结它。completed 表示本轮贡献
已经交付，允许携带非空 remaining；回执准确描述已确认事实、修改与验证结果、证据引用、
验证范围及未完成工作。blocked 表示存在具体阻塞，必须说明 remaining。
Agent 可在有用的工作边界或上下文压力下提交 completed 回执并正常结束本轮；外层读取
报告与证据后，决定继续分派、调整边界或收口。后续工作在同一 Goal 下自行声明新的
Commitment，已终结的 Commitment 保留原样。

Goal 状态是报告投影：最新报告声明了 remaining 时，completed 回执结束这次贡献，
Goal 保持 pending（依赖未满足时为 waiting），不会仅凭该 completed 标签放行依赖。
外层仍需结合 Goal 的完整报告与证据判断整体结果；空 remaining 也不是独立验收证明。

Runtime crash、provider failure、取消、超时、
输出截断、缺少 Claim/Receipt 都是事件，不是模型语义结果。Receipt 不得承载日志、diff、
指标标签或私有 checkpoint；观测从真实事件与状态推导，不要求模型声明统计事实。

## 5. Context 与恢复

每次 assignment 启动时追加确定性的当前 Goal、必要根 Goal 摘要、当前 Goal 的历史
Commitment/Receipt 摘要、可选原 Commitment、简洁 Receipt 折叠状态与 focus。摘要通过
id 召回完整记录；投影中任意字符串超过 600 字符取前 300 + 省略号 + 后 300，持久内容
不截断。已发送的上下文 prefix 不被后续持久记录改写。

fresh spawn/resume 不复制其他 session。followup 恢复本 Agent 的真实 Pi session，
再追加新的工作输入和当前状态；这改变了旧版本“永不恢复 session”的限制。session 是
私有执行状态而非持久工作协议；外层只用结构化结果评估工作，不读取工具对话/推理。
Pi session 的 cwd 必须与 Task 仓库一致，缺少有效 session 时不能声称复用了上下文。

Agent 应在仍有余量时，把当前成果、验证范围和接续工作写入 completed 回执并正常结束。
Runtime 在每次 provider request 前使用 Pi 的 context usage 估计检查 50%、70%、80%
三个阈值，持久写入 `context_pressure(UPDATED)` 事件。每个 execution 只在首次达到
更高档位时发出一条；一次跨过多个阈值时只报告当前最高档位，回落再上升不重复通知。
新的 execution（包括 followup/resume）独立判断阈值，旧执行的信号保留原有归属。
事件包含 Task、Goal、execution、可用的 Agent/Commitment id，以及 `context_pressure`
对象：`basis=pi_estimate`、`utilization` 比值、`threshold` 比值、`tokens` 与
`context_window`。未知或无效估计不生成压力事件，不把缺失用量当作零。
`watch` 通过现有 `type=event` 流输出该事件，`--since` 可用于断线后的持久事件接续。
外层据此结合进度回执评估接续工作和 session 余量；压力事件本身不结束执行或承诺。
80% 压力事件先落盘，再进入下面的既有中断路径。
Pi context utilization 达到 80% 时，在下一 provider request 前停止，记录
`CONTEXT_BUDGET_EXCEEDED`，不写假的 blocked/completed。开放 Commitment 保持开放；
进程确认停止后由外层显式 resume，使用新 session 继续原承诺。禁用自动 compaction，
避免未经外层决定的隐藏续跑。Usage 按真实 execution 与 Task 累计，包含复用与恢复轮次。
新的 Task usage 记录带 `agent_id` / `execution_id`，包括 Claim 前的响应；历史记录
可以缺失这两个字段，不通过同 Goal 或模型名猜测 Agent 归属。正常进展不重复打印
usage，按用户请求或最终简要核算时再按 Task 列出；reasoning 是 output 的子集。

## 6. 单执行器与测量边界

`codeflow exec` 是直接启动一个执行者的便捷入口/基线，不自带递归调度循环。
执行者的 shell 并未禁止调用 codeteam，因此单执行器入口不等于派生隔离保证。
standalone runner 的根 Commitment 终结仍生成该 standalone run 的结束事件。
`codeflow resume` 仅恢复这种 fully stopped standalone run，不用于外层 team Task。

旧 Codemark first-turn 内层 Manager live 测量退役：不得给三 action 执行器套回四 action
并声称在测当前编排。可以读取历史 artifact。SWE 官方评测以冻结 candidate patch 的
official harness report 为准；外层准备/评测不会隐式运行一个 Manager。单执行器基线与
外层编排结果必须标识清楚，外层宿主用量不可得时不得记为零。

## 7. 保持的不变量

1. 外层统筹整体结果；Pi 保留 codeteam，暂不施加专门的派生限制。
2. Goal 一对多可复用；session 复用与 Goal 复用不同。
3. Commitment 自行声明、不可变，记录工作归属而非授予工具权限。
4. Receipt append-only，Runtime failure 不伪造语义结果。
5. 新建/复用异步，无模型等待工具、隐式排队或管理模型空转。
6. 同一 session 只有一个 writer；未确认停止的执行不得被复用。
7. Task 结束由外层验证并显式提交，单个 Agent 的完成不等于全局完成。
8. canonical JSON、content identity 与共享 append-only 顺序继续有效。

主动拆分方法延续此前对公开 `openai/codex` commit
`ddf04ad26789d040f9ef6a96736f76602e35a6cc` 的有界独立工作、避免重复和共享容量的适配，
但执行者现在是外层 loop；本版本不声称实现 Codex 的 RPC、session fork、LRU 或 live steer。
