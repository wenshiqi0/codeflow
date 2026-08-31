# Codeflow

Codeflow 是基于 Pi 的 Goal-scoped 多 Worker 执行 Runtime。Root 负责组织与收口，
Child Worker 负责自己声明并完成工作；系统不使用固定 planner、coder、tester 或
reviewer 角色。

> 协同对象、action、字段、状态与不变量由
> [Codeflow Collaboration Semantics](docs/collaboration-semantics.md) 统一定义。
> 该文档是规范性语义基线；README 只提供使用入口，不复制另一套协议。

## 核心模型

模型只需要理解：

```text
Goal        稳定的结果边界
Commitment  一个 Worker 自己声明的工作承诺
Receipt     该 Commitment 的进展或结果
Worker      执行并拥有 Commitment 的主体
```

Task 是 Runtime 容器并充当根 Goal，不是额外的工作协议。一个 Goal 可以包含多个
Commitment，也可以在完成一个 Commitment 后再次委派给新的 Worker；只有结果或依赖
边界实质变化时才创建新 Goal。

所有 Worker 只看到一个 `collaborate` 工具。共同 action 是 `inspect`、`claim`、
`report`；Root 额外拥有 `delegate` 与 `wait`。Root 的 Pi 工具面是
`read,collaborate`，Child Worker 保留正常编辑和执行工具。Root 必须至少委派一名
Worker 承担实质仓库工作。

委派是异步的。Root 继续检查、组织或委派；只有下一项管理决策对 Worker 结果存在必须
立即满足的强依赖时才使用 `wait`，并在 Worker Claim、提交进展 Receipt 或结束时返回。
Child 在 Claim 前只能进行只读仓库检查；Runtime 会拦截编辑、写入和不能明确判定为
只读的命令。Claim 不等待 Root 审批，但 Root 可检查其 Commitment 并异步调整组织。

`claim` 只表达 `work` 以及可选的 `done_when`、`constraints`。`report` 只表达
`progress|completed|blocked`、`summary` 以及可选的 `effects`、`remaining`。
revision、内容身份、执行归属、并发锁和观测分类均由 Runtime 管理。

## 提示词分层

- `references/manager.md`：只注入 Root，定义管理、委派、整合与收口方法；
- `references/worker.md`：只注入执行 Worker，定义工程实施、验证与回执方法。

Manager 默认使用 GLM-5.3，Worker 默认使用 MiMo v2.5 Pro；两者保持 high thinking，
并通过提示词与工具能力区分工作层次。两份提示词不增加协议字段；目标仓库自己的
`AGENTS.md` 由 context extension 动态注入。

## 命令

```bash
codeflow exec [--manager-model <provider/model>] [--worker-model <provider/model>] "<objective>"
codeflow resume <task-id>
codeflow ls
codeflow sub <task-id> [--since <seq>] [--kind <kind>,...] [--timeout 600]
codeflow goals <task-id>
codeflow usage <task-id>
codeflow audit <task-id> [--force]
codeflow stop <task-id>
```

外层观察者只传入用户的 issue 或需求，不附加复杂度分类、时间估计、Worker 数量或
预设拓扑。Root 从仓库证据判断如何委派。`exec --manager-model` 只覆盖 Manager，
`exec --worker-model` 只覆盖执行 Worker；两者都不修改配置或内部 service 模型。

`code-agent` 只提供执行辅助命令：

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

默认 Worker context 是 pull-first：当前 Goal、Child 所需的根 Goal 摘要、同一 Goal
下带 id 的历史 Commitment/Receipt 摘要、可选的当前 Commitment、简洁 Receipt 状态
和临时 focus。超过 600 字符的注入文本只保留前后各 300 字符，持久记录保持完整；可用
`inspect(commitment_id=...)` 或 `inspect(receipt_id=...)` 召回。该 context 在一次
execution 内保持固定，避免历史增长改写 provider prefix。

Child Worker 的 context utilization 达到 80% 时，Runtime 会先写入 `blocked` Receipt
（Claim 前则写 execution blocker），说明单个 Worker 无法安全完成并建议 Manager
拆分剩余工作，然后程序化结束该 Worker。

## 观测与 Benchmark

使用量、工具活动、prompt shape 和 Commitment lifecycle 都通过隐私安全的 Runtime
记录观测。拓扑从真实父子 Commitment 推导；模型不写 `obligation.*`、decomposition
声明或其他指标标签。官方 SWE-bench evaluator 决定 benchmark verdict，Receipt 不
替代评测结果。详细契约见 [Benchmark contract](docs/benchmark-contract.md)。

## 目录

```text
docs/collaboration-semantics.md          规范性协同语义基线
runtime/config.json                      Worker 与内部 service 模型配置
runtime/lib/                             Goal/Commitment/Receipt 与观测核心
runtime/extensions/codeflow-context/     临时 working set 注入
runtime/extensions/codeflow-organization/ 单一 collaborate 工具
references/manager.md                    Manager 管理方法
references/worker.md                     Worker 工程方法
benchmark/                               SWE-bench driver 与报告
```

## 配置与验证

`runtime/config.json` 分别配置 manager、worker 的模型和提示词，以及内部 service。
provider 定义来自 `runtime/models.json` 和可选的本机 `runtime/providers.json`；密钥只
从环境读取。模型可显式声明 `thinkingLevel`、`contextWindow` 和 `maxTokens`。

```bash
bun install
bun run typecheck
bun test
./scripts/doctor.sh
```

## 安装

仓库可作为宿主 skill 使用，也可直接运行 `runtime/bin/codeflow`。放入用户 `PATH` 时，
使用指向真实仓库入口的启动脚本：

```bash
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\nexec "%s/runtime/bin/codeflow" "$@"\n' "$PWD" > "$HOME/.local/bin/codeflow"
chmod 755 "$HOME/.local/bin/codeflow"
```
