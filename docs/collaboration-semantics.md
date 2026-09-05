# Codeflow Collaboration Semantics

Status: **Normative**

本文档是 Codeflow 模型可见协同语义的唯一基线。代码、提示词、README 与测试若有
冲突，以本文档为准。新增模型可见名词、action、字段或状态，必须先修改本文档并说明
为什么现有语义无法表达；禁止以兼容别名、隐藏字段或魔法字符串绕过这条约束。

## 1. 语义对象

模型只需要理解四个持久协同对象：

```text
Goal        想要达到的稳定结果边界
Commitment  一个 Agent 对 Goal 内一块工作的承诺
Receipt     该 Commitment 实际发生了什么
Agent       执行并拥有 Commitment 的主体
```

Task 是一次 Runtime 运行的容器，同时充当根 Goal；它不是第五种工作协议。根 Goal
使用 `goal_id = task_id`，只有需要独立结果、依赖、调度或召回边界时才创建 Child
Goal。不得创建 `_root`、`_default`、`_ungrouped` 等合成或兼容 Goal。

Root 与 Child 只表示委派拓扑，不是角色、人员类型或能力等级。所有执行主体都是 Agent，
使用同一份提示词、模型配置、协同 action 和工程工具。Root 额外承担整个 Task 的结果责任，
但可以自行实现和验证；Child 也可以组织工作、创建或复用 Goal，并递归委派。

## 2. Goal 与 Agent 的关系

Goal 与 Agent **不是一对一**：

- 一个 Agent execution 一次只在一个 Goal 内工作；
- 一个 Commitment 只属于一个 Goal 和一个 Agent execution；
- 一个 Goal 可以拥有多个顺序或并发 Commitment；
- 任一 Agent 可以再次把已有 Goal 委派给新的 Agent；
- 一个 Receipt 关闭的是 Commitment，不会永久封死 Goal；
- 更换 Agent、重试、补充验证或新证据出现时，不得仅因此复制 Goal。

当结果边界没有变化时必须复用旧 Goal。只有结果、依赖、调度或召回边界发生实质变化
时才创建新 Goal。并发 Commitment 必须拥有不重叠的工作边界；Runtime 负责原子记录，
委派者与参与执行的 Agent 负责发现和纠正语义重叠。委派不限于任务首轮，也不限制为
一层：在任何时点，只要一个边界明确、可独立推进的子任务能提高速度或质量，任一 Agent
都应主动委派，同时继续推进自己可完成的关键路径。不得重复分派同一工作或与 Child
并行写入相同边界。Runtime 使用 Task 范围的共享并发上限，而非按深度分配能力；
`CODEFLOW_MAX_CONCURRENT_AGENTS` 默认 8，包含 Root 与所有层级的 Child 执行进程。
容量已满时 `delegate` 返回可处理的容量错误，不自动排队或阻塞；Agent 可以继续自身
工作，在已有 Child 结束后根据需要重新委派。
简单、明确的工作可以由一个 Agent 完成，不要求最少 Child 数量或固定开发/测试角色。
独立验证依据风险和未解决的不确定性安排，不以人数或头衔代替证据。

## 3. Commitment

Agent 在检查 Goal 和现实状态后自行创建 Commitment；委派者只能提供临时 focus，不能
替 Child 写好承诺。focus 是简洁、连贯的语义提示，不是持久契约；600 字是委派者
的表达纪律，而不是 Runtime 校验、截断或兼容规则。模型可见字段只有：

```text
work         必填；该 Agent 拥有的工作边界
done_when    可选；可观察的完成条件
constraints  可选；真实存在的约束
```

`work` 描述 Agent 要建立并交付的工作边界，不得把尚未由证据检查的关键技术判断
写成已经确定的实现边界。Agent 可以说明当前方向，但必须保留验证推翻该方向的空间。
当 `work` 包含封闭的技术边界，例如精确的输入或字段集合时，必须先检查能够改变该边界
的相关消费者与变体；否则应承诺建立该边界，而不是把常见路径直接写成答案。
这是 Commitment 文本的质量要求，不引入新字段、状态或对象。

所有 Agent 在 Claim 成功前只能做只读仓库检查；任何编辑、写入或无法明确证明为只读的命令
都由 Runtime 拦截。委派同样要求委派者已有开放的 Commitment。Claim 建立后 Agent 可立即
继续，不等待 Parent 审批；同时 `commitment_claimed` 使 Parent 能异步看到该 Commitment，
并在组织决策依赖其工作边界时接收 Runtime 的非阻塞通知，再通过 `inspect` 判断是否调整
组织。Parent 应判断 Child 的工作边界是否有证据支持，
以及是否因未验证的技术判断而过早收窄；必要时调整组织或另行委派交叉验证，而不是替
Child 修改 Commitment。单独 `inspect` 不构成覆盖范围的调整；Parent 一旦判断边界过窄，
必须先通过自身工作或委派扩大证据或工作覆盖，才能提交 terminal Receipt。

Goal、focus 和已有报告不是不可质疑的命令。Agent 应在现实证据冲突时简洁反馈异议，
并通过独立观察、交叉检查和反证尝试形成高置信共识；重复或服从本身不构成共识。

`claim_revision`、内容身份、父 Commitment、execution id 和并发锁属于 Runtime 元数据，
不得要求模型复制或管理。工程上的 invariant、falsification、测试方法与证据判断属于
工作方法，不是每次 Claim 的协议字段。

Commitment 创建后不可修改。Agent 可以用 Receipt 关闭它，再在同一 Goal 下建立新的
Commitment；不需要 `superseded` 状态或替换引用。

## 4. Receipt

模型可见字段只有：

```text
status     progress | completed | blocked
summary    必填；本次报告的结果或阻塞
effects    可选；Git、文件、外部系统或服务中的可观察引用
remaining  可选；当前尚未完成的工作
```

- `progress` 不关闭 Commitment；
- `completed` 关闭 Commitment，且 `remaining` 必须为空；
- `blocked` 关闭 Commitment，且必须说明 `remaining`；
- Runtime crash、provider failure、取消、超时和输出截断是事件，不是 Receipt；
- 不存在模型可选的 `partial`、`failed` 或 `superseded` Receipt；
- 不存在 `established`、`decisions`、`discovered`、`unresolved`、`blockers` 或
  `resolved*` 事实分类。

Receipt 是简洁结果，不是 transcript、日志、diff、checkpoint、评审表或指标声明。
`obligation.*`、`decomposition: ...` 等魔法字符串不得进入协议；观测系统必须从真实
tool、Commitment、Receipt 与父子关系推导指标。

Agent 在 Claim 前无法形成可靠承诺时，也使用 `report(status="blocked")` 向 Parent
反馈。该报告属于 execution 反馈，不伪造 Commitment 或 Receipt，也不引入另一套
issue 分类。

## 5. collaborate 工具

每个 Agent 获得同一个 `collaborate` 工具，action surface 不因拓扑位置改变：

```text
所有 Agent: inspect, claim, report, delegate
```

- `inspect` 查看当前或指定 Goal，或使用 `commitment_id` / `receipt_id` 召回一个
  Commitment、完整 Receipt 链或单个 Receipt；没有 recall level，也没有独立的
  Receipt 查询 action。
- `claim` 创建当前 Agent 的 Commitment。
- `report` 汇报进展、完成或阻塞；Claim 前只允许 `blocked`。
- `delegate` 使用扁平 `goal_id` 再次委派已有 Goal，或使用 `new_goal` 提供
  `goal_id`、`objective` 和可选依赖来创建 Child Goal；两者必须且只能出现一个。

协同工具不提供阻塞等待 action。任一 Child 创建 Commitment、提交 Receipt 或执行结束时，
Runtime 将已有 Commitment/Receipt id 或执行结果通知其 Parent；Parent 通过 `inspect`
读取完整反馈。通知是 Runtime 对既有对象和事件的投影，不是新的持久协议对象。
不能用另一种名称的等待工具、忙轮询或同步子调用恢复被移除的阻塞路径。

任一 Agent 在拥有开放 Commitment 后都能创建或复用 Goal、启动 Child Agent，Child
拥有相同能力。委派可以递归发生，没有固定深度上限。没有 Child 的叶节点可以直接完成
自己的工作；存在委派的 Parent 必须确认所有已委派执行及后代 Commitment 结束，并核对
反馈、剩余工作、可观察效果和当前仓库状态，才能提交 terminal Receipt。这里的依赖是
完成条件，不是模型阻塞调用，也不要求为完成而创建一个 Child。

`delegate` 启动 Agent 后立即返回 execution id；委派者继续实现、验证、检查状态、组织
可独立推进的工作或继续委派。暂时没有可推进的工作时，自然结束当前模型轮次即可；
轮次结束不是 Commitment 或 Task 完成。Runtime 在 Child 仍执行时保持其 Parent 存活，
有新反馈时触发该 Parent 继续处理；没有新反馈不空转调用模型。Parent 正在运行时，新反馈
排入后续安全的消息边界，不等待指定 Child，也不取消其他 Agent。该行为适用于任意
深度的 Parent。收到反馈后重新判断和调整组织。Root 的 terminal Receipt 才能建立整个
Task 的语义结束；Child Receipt 只关闭自己的 Commitment。

本版本没有模型可见的跨 Agent 消息或 follow-up action；需要调整时使用现有的
`inspect`、自身工作、Goal 复用、再次委派与 Receipt，不承诺额外通信能力。

## 6. Context 与恢复

默认 context 注入当前 Goal、Child 所需的根 Goal 摘要、当前 Goal 下按持久序号排列的
历史摘要、可选的当前 Commitment、其简洁 Receipt 折叠状态和临时 focus。历史使用与
`goal` 同级的 `<commit id="...">...</commit>` 与
`<receipt id="...">...</receipt>`；Commitment 的摘要取 `work`，Receipt 的摘要取
`summary`。id 可交给 `inspect` 召回完整持久记录。注入投影中的任意字符串超过 600 个
字符时只保留前 300 个字符、一个省略号和后 300 个字符；持久记录本身不得截断。

Context 是一次 Agent execution 启动时的确定性快照，不复制父 session、工具 transcript
或隐藏推理。Commitment 与 Receipt 按共享
单调序号排列，执行期间新增记录不得改写已发送的 context prefix；需要最新状态时使用
`inspect`。新增的 Child 反馈以独立消息追加，不能重写已有 context prefix；Runtime
负责避免重复投递和退出竞态，不要求模型维护通知游标。不存在 `state/semantic/full` recall 档位。

Codemark 使用同一份 Agent 提示词和 Root 的四项协同 action，但以只读方式测量，不启动
Child 或执行仓库写入。测量在 Root Agent 首次
正常自然结束轮次时冻结初始组织（`first_turn_end`），而非引入替代等待 action。
provider 失败、截断、用户中断或超时不构成正常测量完成。零委派本身不是协议违规；
是否有值得独立执行的工作由 Issue 和证据评估，不以固定人数评判组织质量。

任一 Agent 的 Pi context utilization 达到 80% 时，Runtime 必须在发起下一次 provider
请求前停止执行，记录 `CONTEXT_BUDGET_EXCEEDED` Runtime interruption，并中止当前
turn、该 Agent 及其执行子树。该容量保护不是语义上的 `blocked`：不得因此写 terminal
Receipt 或 Claim 前的语义 blocker；所有原本开放的 Commitment 保持开放，已有真实
Receipt 不变。这样不会由一个容量中断提前关闭 Parent，阻断尚未完成后代的精确恢复。
Root 与 Child 受同一上限约束。attempt 完全停止后，显式 `resume` 通过已有持久记录和
当前外部状态继续原 Commitment；不伪造新的承诺、完成结果或恢复旧 session。

Context、session、focus、tool observation 和推理都不是持久语义。中断恢复读取原
Commitment、已有 Receipt、Runtime 事件和当前外部状态；不恢复隐藏推理或创建私有
checkpoint。恢复同一 Commitment 不等于 Parent 重写 Child 的承诺。

## 7. 必须保持的不变量

1. 模型可见持久对象只有 Goal、Commitment、Receipt、Agent。
2. Goal 是一对多、可再次委派的稳定结果边界。
3. Commitment 由执行它的 Agent 自己声明；所有 Agent 先 Claim 再产生工作效果或委派。
4. 所有 Agent 都能创建或复用 Goal、递归委派；Root/Child 仅表示拓扑。
5. 工具 action 统一为 inspect、claim、report、delegate，Agent 之间没有阻塞等待工具。
6. Claim 和 Receipt 字段不得演化成计划书、工作日志或观测标签。
7. Runtime failure 不得伪造 Receipt。
8. 观测指标从真实状态推导，不要求模型声明。
9. 持久记录使用 canonical JSON、content identity 与 append-only 顺序。
10. 删除语义时同时删除实现、提示词、测试、文档和报告字段，不保留兼容残留。

## 8. 编排方法的来源与适配边界

主动委派方法参考公开 `openai/codex` 的 MultiAgentV2，固定于
[`ddf04ad26789d040f9ef6a96736f76602e35a6cc`](https://github.com/openai/codex/tree/ddf04ad26789d040f9ef6a96736f76602e35a6cc)：
其[主动编排模式](https://github.com/openai/codex/blob/ddf04ad26789d040f9ef6a96736f76602e35a6cc/codex-rs/core/src/context/multi_agent_mode_instructions.rs#L7-L8)、
[V2 有界并行工具指导](https://github.com/openai/codex/blob/ddf04ad26789d040f9ef6a96736f76602e35a6cc/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L731-L760)
与[共享执行容量](https://github.com/openai/codex/blob/ddf04ad26789d040f9ef6a96736f76602e35a6cc/codex-rs/core/src/agent/control/execution.rs)
支持在执行过程中持续拆出可独立推进的工作。关键路径、避免重复工作和不重叠写入还参考
同一版本的 [V1 工具指导](https://github.com/openai/codex/blob/ddf04ad26789d040f9ef6a96736f76602e35a6cc/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L700-L727)，
仅作为适配后的工作方法，不将其称作 V2 的完整提示词。Codeflow 保留自己的
Goal、Commitment、Receipt、pull-first context 和非阻塞反馈协议；不据此引入 Codex 的
消息工具、session fork、LRU 驻留管理或其他未实现能力。
