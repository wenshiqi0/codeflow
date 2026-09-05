# Codeflow

Codeflow 是基于 Pi 的 Goal-scoped 多 Agent 执行 Runtime。所有 Agent 使用同一份
提示词、模型配置和工具能力，可以实现、验证、组织并递归委派。Root 与 Child 只表示
拓扑；Root 承担整个 Task 的结果责任。系统不使用固定 planner、coder、tester 或
reviewer 角色，也不要求简单任务必须创建 Child。

> 协同对象、action、字段、状态与不变量由
> [Codeflow Collaboration Semantics](docs/collaboration-semantics.md) 统一定义。
> 该文档是规范性语义基线；README 只提供使用入口，不复制另一套协议。

## 核心模型

模型只需要理解：

```text
Goal        稳定的结果边界
Commitment  一个 Agent 自己声明的工作承诺
Receipt     该 Commitment 的进展或结果
Agent       执行并拥有 Commitment 的主体
```

Task 是 Runtime 容器并充当根 Goal，不是额外的工作协议。一个 Goal 可以包含多个
Commitment，也可以在完成一个 Commitment 后再次委派给新的 Agent；只有结果或依赖
边界实质变化时才创建新 Goal。

所有 Agent 都获得同一个 `collaborate` 工具，action 是 `inspect`、`claim`、`report`、
`delegate`，并保留正常的仓库读取、编辑和执行工具。任意 Agent 都可以在执行中发现
独立工作时创建或复用 Goal 并委派；没有固定深度限制。主动分工以速度、质量和不确定性
为依据，委派者同时推进自身关键路径，避免重复工作和重叠写入。

委派和反馈都是异步的，不提供 Agent 间阻塞等待工具。任一 Child Claim、提交 Receipt
或结束时，Runtime 向其 Parent 追加通知，Parent 可用 `inspect` 读取完整反馈。暂时
没有可推进的工作时，Agent 自然结束当前轮次；Runtime 在 Child 运行期间保持其 Parent
存活，新反馈再触发 Parent，没有新事件就不空转调用模型。这适用于任意深度。
轮次结束不等于 Commitment 或 Task 完成；所有委派后代的工作与反馈核对完毕后，
Parent 才能提交 terminal Receipt，Root 的 terminal Receipt 报告整体结果。
所有 Agent 在 Claim 前只能进行只读仓库检查；Runtime 会拦截编辑、写入和不能明确
判定为只读的命令，委派也需要开放 Commitment。Claim 不等待 Parent 审批。

`CODEFLOW_MAX_CONCURRENT_AGENTS` 默认 8，限制一个 Task 中 Root 和所有层级 Child
的并发执行进程。容量满时委派返回可处理的错误，不自动排队或阻塞；Agent 可继续自身
工作并在容量释放后重新评估。本版本不提供跨 Agent 的 message/follow-up action。

`claim` 只表达 `work` 以及可选的 `done_when`、`constraints`。`report` 只表达
`progress|completed|blocked`、`summary` 以及可选的 `effects`、`remaining`。
revision、内容身份、执行归属、并发锁和观测分类均由 Runtime 管理。

## 统一 Agent 提示词

`references/agent.md` 同时注入 Root 和每一层 Child，统一声明、主动组织、工程实施、
独立验证、整合与回执方法。模型配置来自 `runtime/config.json` 的 `agent` 项，不以
管理/开发身份切换模型或工具能力。目标仓库自己的 `AGENTS.md` 由 context extension
动态注入。

主动编排方法借鉴公开 Codex 源码并适配 Codeflow 协议，具体来源和未引入的能力见
[规范中的来源说明](docs/collaboration-semantics.md#8-编排方法的来源与适配边界)。

## 命令

```bash
codeflow exec [--model <provider/model>] "<objective>"
codeflow resume <task-id>
codeflow ls
codeflow sub <task-id> [--since <seq>] [--kind <kind>,...] [--timeout 600]
codeflow goals <task-id>
codeflow usage <task-id>
codeflow audit <task-id> [--force]
codeflow stop <task-id>
```

若只想测量 Root Agent 面对一个 Issue 时的首次分工，可使用独立的 `codemark` 命令：

```bash
codemark [--model <provider/model>] [--out <dir>] [--timeout 300] "<issue>"
printf '%s\n' "<issue>" | codemark --out .codemark/runs/example
```

Codemark 使用与生产 Root 相同的 `agent.md`、Goal context、启动指令与四项协同 action，
但保持只读测量边界，不执行仓库写入。host 侧把 `delegate` 解释为提议记录，绝不启动
Child。Root 首次正常自然结束轮次即结束测量。默认产物目录为
`$CODEFLOW_HOME/codemark/runs/<run-id>`（未设置时
`~/.codeflow/codemark/runs/<run-id>`），不会写入被测仓库；`--out` 指定的则是本次 run
尚不存在的精确目录。模型运行期间，`request.json` 与可变 `frontier.json` 只存在于
仓库外、随机命名且权限为 `0700` 的 staging；`read` 保留生产 schema 和实现，但只允许
canonical target 位于被测仓库内，并拒绝 staging、`/proc`、`/dev/fd` 等进程状态路径。
host 汇总 usage 并确定终态后，才把包含
`request.json`、`usage.json` 和不可变 `initial-organization.json` 的完整目录一次原子
发布。因此公开 artifact 始终同时包含有序的初始委派前沿和精确 usage 汇总；
`usage.json` 则保留逐回合明细。`delegate_count` 统计全部初始委派意图；
`initial_worker_count` 只统计依赖已满足、在生产环境会立即启动的 Agent，依赖未满足的
意图单列为 `waiting_on_dependencies_count`。即使模型未 claim 或以零 delegate
结束首轮，测量也会成功保存为 `first_turn_end`；未 claim 等协议偏差另行记录于
`assessment.policy_violations`。零委派本身合法，组织质量应结合 Issue 的独立工作机会
判断，不能以 Child 数量直接替代。模型正文、隐藏推理和工具
transcript 不会持久化。Codemark 不是 Codeflow Task，也不会生成 canonical Commitment 或
Receipt，因此适合作为便宜、快速且不污染生产协同语义的分工基线。

Codemark artifact v1 保留 `manager`、`manager_claim`、`manager_progress` 和 `*_worker_*`
等既有序列化字段名，它们表示测量中的 Root 与 Child 数据，不代表不同角色。旧报告条目
省略 `status` 时仍表示 progress；新的叶节点终态报告显式记录 completed/blocked，仍然
只是模拟记录，不生成正式 Receipt，也不把测量成功解释为 Issue 已真实完成。

外层观察者只传入用户的 issue 或需求，不附加复杂度分类、时间估计、Agent 数量或
预设拓扑。Agent 从仓库证据判断如何委派。`exec --model` 覆盖本次 Task 所有 Agent，
`codemark --model` 选择本次只读测量模型；两者都不修改配置或内部 service 模型。

`codeteam` 只提供执行辅助命令：

```text
evidence run|batch|log
check source
```

## 持久化与恢复

每个 Task 位于 `.codeflow/runs/code/<task-id>/`。核心数据是 `task.json`、`goals/`、
`commitments/<id>/commitment.json`、对应的 `receipts/`、`events/` 与 `runner.json`。
Commitment 和 Receipt 使用 canonical JSON、content identity 与共享单调顺序。

`progress` Receipt 保持 Commitment 开放；`completed` 和 `blocked` 关闭它。进程、
provider、tool、超时、取消或输出截断产生 Runtime interruption event，不伪造
Receipt。显式 `resume` 只在 attempt 已终止且 `runner_exited` 后继续原 Commitment，
不会恢复旧 session、隐藏推理或 checkpoint。

默认 Agent context 是 pull-first：当前 Goal、Child 所需的根 Goal 摘要、同一 Goal
下带 id 的历史 Commitment/Receipt 摘要、可选的当前 Commitment、简洁 Receipt 状态
和临时 focus。超过 600 字符的注入文本只保留前后各 300 字符，持久记录保持完整；可用
`inspect(commitment_id=...)` 或 `inspect(receipt_id=...)` 召回。该 context 在一次
execution 内保持固定，避免历史增长改写 provider prefix；不复制父 session、工具
transcript 或隐藏推理。

任一 Agent 的 context utilization 达到 80% 时，Runtime 记录
`CONTEXT_BUDGET_EXCEEDED` interruption，并中止该 Agent 及其执行子树。Root 与 Child
受同一上限约束。容量中断不写 `blocked` Receipt 或 Claim 前的语义 blocker；原本
开放的 Commitment 保持开放，attempt 完全停止后可通过显式 `resume` 继续原承诺。

## 观测与 Benchmark

使用量、工具活动、prompt shape 和 Commitment lifecycle 都通过隐私安全的 Runtime
记录观测。拓扑从真实父子 Commitment 推导；模型不写 `obligation.*`、decomposition
声明或其他指标标签。官方 SWE-bench evaluator 决定 benchmark verdict，Receipt 不
替代评测结果。详细契约见 [Benchmark contract](docs/benchmark-contract.md)。

## 目录

```text
docs/collaboration-semantics.md          规范性协同语义基线
runtime/config.json                      Agent 与内部 service 模型配置
runtime/lib/                             Goal/Commitment/Receipt 与观测核心
runtime/extensions/codeflow-context/     临时 working set 注入
runtime/extensions/codeflow-organization/ 单一 collaborate 工具
references/agent.md                      统一 Agent 编排与工程方法
benchmark/                               SWE-bench driver 与报告
```

## 配置与验证

`runtime/config.json` 使用 `agent: { model, prompt }` 统一配置所有 Agent，以及独立的内部 service。
provider 定义来自 `runtime/models.json` 和可选的本机 `runtime/providers.json`；密钥只
从环境读取。模型可显式声明 `thinkingLevel`、`contextWindow` 和 `maxTokens`。

```bash
bun install
bun run typecheck
bun test
./scripts/doctor.sh
```

## 安装

仓库可作为宿主 skill 使用，也可直接运行 `runtime/bin/codeflow` 与
`runtime/bin/codemark`。放入用户 `PATH` 时，使用指向真实仓库入口的启动脚本：

```bash
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\nexec "%s/runtime/bin/codeflow" "$@"\n' "$PWD" > "$HOME/.local/bin/codeflow"
chmod 755 "$HOME/.local/bin/codeflow"
printf '#!/bin/sh\nexec "%s/runtime/bin/codemark" "$@"\n' "$PWD" > "$HOME/.local/bin/codemark"
chmod 755 "$HOME/.local/bin/codemark"
```
