# Codeflow Collaboration Semantics

Status: **Normative**

本文档是 Codeflow 模型可见协同语义的唯一基线。代码、提示词、README 与测试若有
冲突，以本文档为准。新增模型可见名词、action、字段或状态，必须先修改本文档并说明
为什么现有语义无法表达；禁止以兼容别名、隐藏字段或魔法字符串绕过这条约束。

## 1. 语义对象

模型只需要理解四个持久协同对象：

```text
Goal        想要达到的稳定结果边界
Commitment  一个 Worker 对 Goal 内一块工作的承诺
Receipt     该 Commitment 实际发生了什么
Worker      执行并拥有 Commitment 的主体
```

Task 是一次 Runtime 运行的容器，同时充当根 Goal；它不是第五种工作协议。根 Goal
使用 `goal_id = task_id`，只有需要独立结果、依赖、调度或召回边界时才创建 Child
Goal。不得创建 `_root`、`_default`、`_ungrouped` 等合成或兼容 Goal。

Root 与 Child 不是角色或人员类型，只表示 Runtime 赋予进程的能力不同。所有执行主体
都是 Worker。

## 2. Goal 与 Worker 的关系

Goal 与 Worker **不是一对一**：

- 一个 Worker execution 一次只在一个 Goal 内工作；
- 一个 Commitment 只属于一个 Goal 和一个 Worker execution；
- 一个 Goal 可以拥有多个顺序或并发 Commitment；
- Root 可以再次把已有 Goal 委派给新的 Worker；
- 一个 Receipt 关闭的是 Commitment，不会永久封死 Goal；
- 更换 Worker、重试、补充验证或新证据出现时，不得仅因此复制 Goal。

当结果边界没有变化时必须复用旧 Goal。只有结果、依赖、调度或召回边界发生实质变化
时才创建新 Goal。并发 Commitment 必须拥有不重叠的工作边界；Runtime 负责原子记录，
Root 负责发现和纠正语义重叠。

## 3. Commitment

Worker 在检查 Goal 和现实状态后自行创建 Commitment；Root 只能提供临时 focus，不能
替 Child 写好承诺。focus 是简洁、连贯的语义提示，不是持久契约；600 字是 Manager
的表达纪律，而不是 Runtime 校验、截断或兼容规则。模型可见字段只有：

```text
work         必填；该 Worker 拥有的工作边界
done_when    可选；可观察的完成条件
constraints  可选；真实存在的约束
```

`work` 描述 Worker 要建立并交付的工作边界，不得把尚未由证据检查的关键技术判断
写成已经确定的实现边界。Worker 可以说明当前方向，但必须保留验证推翻该方向的空间。
当 `work` 包含封闭的技术边界，例如精确的输入或字段集合时，必须先检查能够改变该边界
的相关消费者与变体；否则应承诺建立该边界，而不是把常见路径直接写成答案。
这是 Commitment 文本的质量要求，不引入新字段、状态或对象。

Child 在 Claim 成功前只能做只读仓库检查；任何编辑、写入或无法明确证明为只读的命令
都由 Runtime 拦截。Claim 建立后 Worker 可立即继续，不等待 Root 审批；同时
`commitment_claimed` 使 Root 能异步看到该 Commitment，并在管理决策依赖其工作边界时
接收 Runtime 的非阻塞通知，再通过 `inspect` 判断是否调整组织。Root 应判断 Child 的工作边界是否有证据支持，
以及是否因未验证的技术判断而过早收窄；必要时调整组织或另行委派交叉验证，而不是替
Child 修改 Commitment。单独 `inspect` 不构成覆盖范围的调整；Root 一旦判断边界过窄，
必须先通过现有管理能力扩大证据或工作覆盖，才能提交 terminal Receipt。

Goal、focus 和已有报告不是不可质疑的命令。Worker 应在现实证据冲突时简洁反馈异议，
并通过独立观察、交叉检查和反证尝试形成高置信共识；重复或服从本身不构成共识。

`claim_revision`、内容身份、父 Commitment、execution id 和并发锁属于 Runtime 元数据，
不得要求模型复制或管理。工程上的 invariant、falsification、测试方法与证据判断属于
工作方法，不是每次 Claim 的协议字段。

Commitment 创建后不可修改。Worker 可以用 Receipt 关闭它，再在同一 Goal 下建立新的
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

Worker 在 Claim 前无法形成可靠承诺时，也使用 `report(status="blocked")` 向 Root
反馈。该报告属于 execution 反馈，不伪造 Commitment 或 Receipt，也不引入另一套
issue 分类。

## 5. collaborate 工具

每个 Worker 只获得一个 `collaborate` 工具。可信进程类型决定 action surface：

```text
所有 Worker: inspect, claim, report
仅 Root:    delegate
```

- `inspect` 查看当前或指定 Goal，或使用 `commitment_id` / `receipt_id` 召回一个
  Commitment、完整 Receipt 链或单个 Receipt；没有 recall level，也没有独立的
  Receipt 查询 action。
- `claim` 创建当前 Worker 的 Commitment。
- `report` 汇报进展、完成或阻塞；Claim 前只允许 `blocked`。
- `delegate` 使用扁平 `goal_id` 再次委派已有 Goal，或使用 `new_goal` 提供
  `goal_id`、`objective` 和可选依赖来创建 Child Goal；两者必须且只能出现一个。

协同工具不提供阻塞等待 action。任一 Child 创建 Commitment、提交 Receipt 或执行结束时，
Runtime 将已有 Commitment/Receipt id 或执行结果通知 Root；Root 通过 `inspect`
读取完整反馈。通知是 Runtime 对既有对象和事件的投影，不是新的持久协议对象。
不能用另一种名称的等待工具、忙轮询或同步子调用恢复被移除的阻塞路径。

只有 Root 能创建 Goal 或启动 Worker。Root 必须先拥有开放的 Commitment，并且至少有
一个 Child Commitment、所有已委派 Worker 与 Child Commitment 都结束后，才能提交
terminal Receipt。`delegate` 启动 Worker 后立即
返回 execution id；Root 应继续检查状态、组织可独立推进的工作或继续委派。暂时没有
可推进的管理工作时，自然结束当前模型轮次即可；轮次结束不是 Task 完成。Runtime 在
Child 仍执行时保持任务存活，有新反馈时触发 Root 继续处理；没有新反馈不空转调用模型。
Root 正在运行时，新反馈排入后续安全的消息边界，不等待指定 Child，也不取消其他 Worker。
收到反馈后重新判断和调整组织。只有 terminal Receipt 才能建立语义上的任务结束。

## 6. Context 与恢复

默认 context 注入当前 Goal、Child 所需的根 Goal 摘要、当前 Goal 下按持久序号排列的
历史摘要、可选的当前 Commitment、其简洁 Receipt 折叠状态和临时 focus。历史使用与
`goal` 同级的 `<commit id="...">...</commit>` 与
`<receipt id="...">...</receipt>`；Commitment 的摘要取 `work`，Receipt 的摘要取
`summary`。id 可交给 `inspect` 召回完整持久记录。注入投影中的任意字符串超过 600 个
字符时只保留前 300 个字符、一个省略号和后 300 个字符；持久记录本身不得截断。

Context 是一次 Worker execution 启动时的确定性快照。Commitment 与 Receipt 按共享
单调序号排列，执行期间新增记录不得改写已发送的 context prefix；需要最新状态时使用
`inspect`。新增的 Child 反馈以独立消息追加，不能重写已有 context prefix；Runtime
负责避免重复投递和退出竞态，不要求模型维护通知游标。不存在 `state/semantic/full` recall 档位。

Codemark 保持与正式 Root 相同的四项工具能力，但不启动 Child。测量在 Manager 首次
正常自然结束轮次时冻结初始组织（`first_turn_end`），而非引入替代等待 action。
provider 失败、截断、用户中断或超时不构成正常测量完成；零委派等组织缺陷单独评估。

Child Worker 的 Pi context utilization 达到 80% 时，Runtime 必须在发起下一次 provider
请求前停止执行。已有开放 Commitment 时写入 `blocked` Receipt，说明工作量超过单个
Worker 的安全执行边界并建议 Manager 拆分剩余工作；尚未 Claim 时使用已有的
execution blocker 反馈。持久化反馈后 Runtime 中止当前 turn 并结束 Worker，不再依赖
模型自行收口。该限制不适用于 Root。

Context、session、focus、tool observation 和推理都不是持久语义。中断恢复读取原
Commitment、已有 Receipt、Runtime 事件和当前外部状态；不恢复隐藏推理或创建私有
checkpoint。恢复同一 Commitment 不等于 Root 重写 Worker 的承诺。

## 7. 必须保持的不变量

1. 模型可见持久对象只有 Goal、Commitment、Receipt、Worker。
2. Goal 是一对多、可再次委派的稳定结果边界。
3. Commitment 由执行它的 Worker 自己声明。
4. Root 独占 Goal 创建与 Worker 委派能力。
5. 工具 action 固定为三项 common 加一项 Root-only，Agent 之间没有阻塞等待工具。
6. Claim 和 Receipt 字段不得演化成计划书、工作日志或观测标签。
7. Runtime failure 不得伪造 Receipt。
8. 观测指标从真实状态推导，不要求模型声明。
9. 持久记录使用 canonical JSON、content identity 与 append-only 顺序。
10. 删除语义时同时删除实现、提示词、测试、文档和报告字段，不保留兼容残留。
