# Codeflow

Codeflow 是基于 Pi 的 Goal-scoped 多 Worker 执行 Runtime。

它只持久化四类核心语义对象：

```text
Task -> Goal Graph -> Handoff -> Receipt
```

`Task` 本身就是 Goal Graph 的高维根 Goal，根级与未拆分工作统一使用
`goal_id = task_id`。只有真正拆分出的结果作用域才创建 Child Goal；系统没有
`_root`、`_default`、`_ungrouped` 或对应兼容层。

所有执行 Agent 都是 Worker，不存在永久 planner、coder、tester、reviewer
身份，也不预设 workflow。Root 仍是 Worker；它的特殊性只来自 Runtime 实际
加载的 Goal、Handoff 和 Worker organization tools。

## 外层启用判定

是否进入 Codeflow 由外层宿主判断，Runtime 内部不做任务分类。调用 skill 执行
新 Task 时，外层提供以下 admission 输入；它不是 `codeflow exec` 的 CLI 参数，
也不会写入 Task objective：

```yaml
admission:
  multi_agent: true | false
  source: explicit_user | outer_assessment
  time:
    solo_estimate: <duration or range>
    parallelizable: true | false
    rationale: <brief evidence>
  coding_complexity:
    level: low | medium | high
    rationale: <brief evidence>
```

时间维度关注单 Worker 的预计关键路径，以及是否存在能抵消启动、同步和收敛成本的
并行工作；编码复杂度关注独立模块、接口、不变量、未知项与验证面的数量和耦合。
预计耗时较长但只能串行等待，或数量很多但机械重复的修改，本身不足以启用。
用户明确指定 Codeflow 时 `source = explicit_user` 并尊重该选择；否则只有
`multi_agent = true` 才启动 Codeflow，缺失或为 `false` 时由外层直接处理。

这个输入只决定是否进入具备多 Worker 能力的 Runtime，不规定角色、阶段、Goal
数量或拆分路径。进入后 Root Worker 仍根据实际发现自主组织，并在最终 Receipt
声明 `decomposition: split | solo — <reason>`。

## 协议

- Goal 是可独立推进、依赖、调度和召回的结果作用域，不是步骤或角色。
- Handoff 在一个 Goal 内开启有边界的 Work Commitment。
- 一个 Handoff 可携带 append-only 的不可变 Receipt 链；Receipt 是增量语义
  delta，不是 snapshot 或 checkpoint。`progress` Receipt 不关闭 Handoff 地
  推进持久语义；只有 terminal Receipt（`completed`、`partial`、`blocked`、
  `failed`、`superseded`）关闭 Handoff 并结束 root run。旧的 schema-v1
  `receipt.json` 记录按单个 terminal Receipt 读取。
- 后续 Receipt 可按稳定引用 resolve 或 supersede 同一 Goal 内的早前事实，
  包括前序 Handoff 产生的语义；折叠后的 decisions、unresolved、blockers
  不会累积过期值。
- Effect 只通过 Git ref、文件路径、外部 ID、服务引用或最小语义描述引用现实状态。
- Context、tool observation、推理和 session 都不是持久语义。
- Runtime failure 只产生中断事件，不伪造 Receipt。

每个 Root Receipt，以及状态为 `completed` 或 `partial` 的 Child Receipt，声明
回归证据、问题复现和下游消费者三类交付义务；不适用时给出理由。义务声明与 Root
的拆分声明由离线观察面分类，不改变 Receipt 状态，也不构成预设执行流程。

默认 Worker context 是 pull-first：只注入 Task、精简后的 root/当前 Goal
state、当前 Handoff、当前 Handoff 的折叠 Receipt 状态和 Receipt head 元数据，
绝不注入完整 root/当前 Goal Handoff/Receipt 历史。显式 recall 支持 Goal、
Handoff 或某个精确 Receipt。Goal 的 `semantic` 只返回最新相关 Handoff 的
折叠 Receipt 状态与 head，不重放增量链；完整链只在 `full` 时返回；
同 Goal 查询可使用 ambient 作用域，跨 Goal 查询必须显式。所有 Handoff/Receipt
使用 canonical JSON 和 SHA-256 content identity，并按共享单调逻辑序保持
append-only 前缀。

## 命令

```bash
codeflow exec "<objective>"
codeflow resume <task-id>
codeflow ls
codeflow sub <task-id> [--since <seq>]
codeflow goals <task-id>
codeflow usage <task-id>
codeflow audit <task-id> [--force]
codeflow stop <task-id>
```

`codeflow` 面向人和外层 Harness。`code-agent` 只在 Worker 进程中暴露：

```text
receipt submit
recall goal|handoff|receipt
evidence run|batch|log
check source
```

Root 进程额外加载模型可见的 `goal_create`、`goal_dependencies`、
`handoff_create`、`handoff_spawn`、`worker_spawn`、`worker_group`；所有 Worker
都有 `receipt` 和 `recall`。`handoff_spawn` 将可选 Child Goal、Handoff 创建和
Worker 启动合并为一次调用，并在首次持久化前整体校验，降低有价值拆分的固定成本。
Runtime 关闭 Pi 的扩展自动发现，只加载各进程显式声明的扩展，因此 Child Worker
不会继承 Root 的 organization tools。Child Worker 每次启动新的 Pi 进程且不传入
既有 session id；完整 session 会保留为审计记录。

每次 provider 请求前，Runtime 在上下文尾部注入统一结构的 `run_facts`，暴露当前
execution 已用轮次与 context utilization，并把隐私安全的数值观测追加到
`run-observations.jsonl`。这些数据提供决策与实验观察信号，不是指令，也不进入
Task/Goal/Handoff/Receipt 的持久语义。

## 恢复语义

每次 attempt 必须先产生以下之一：

- `run_finished`：Root Handoff 已提交 terminal Receipt；
- `run_interrupted`：Root Worker 因进程、provider、tool、取消或上下文故障退出，
  且没有 terminal Receipt；已有持久进度的中断记录为 missing terminal
  Receipt，而不是 DELEGATION_ARTIFACT_MISSING；

之后产生 `runner_exited`，该 Task 才允许显式 `resume`。中断恢复会重新执行原
Handoff，并从 Task、Root/Goal H/R、Goal State 和当前外部状态重新 grounding；
不会恢复旧 session、推理或 checkpoint。已由 Receipt 关闭的 Handoff 永不重开。

## 目录

```text
runtime/config.json                     Worker 与内部 service 模型配置
runtime/lib/                            Task/Goal/Handoff/Receipt 与观测核心
runtime/extensions/codeflow-context/    临时 working set 注入
runtime/extensions/codeflow-protocol/   Receipt 与 Recall tools
runtime/extensions/codeflow-organization/ Root organization tools
references/worker.md                    所有 Worker 共用的执行先验
references/output-compression.md        输出压缩 service 提示
benchmark/                              SWE-bench driver 与报告
```

每个 Task 的运行数据位于 `.codeflow/runs/code/<task-id>/`：`task.json`、
`goals/`、`handoffs/<id>/handoff.json` 加 `handoffs/<id>/receipts/` 的
Receipt 链、`events/`、`usage.jsonl`、`run-observations.jsonl` 和
`runner.json`。不存在用于恢复或传递语义的 facts ledger、conversation snapshot、
collaboration index 或 mutable handoff state；观测 ledger 不能替代 Receipt。

## 配置与验证

`runtime/config.json` 是唯一 executor 配置，区分通用 Worker 和内部
`output_compression` service。provider 定义来自 `runtime/models.json` 与可选的
本机 `runtime/providers.json`；密钥只从环境读取。

```bash
bun install
bun run typecheck
bun test
./scripts/doctor.sh
```

## 安装

仓库可安装为宿主 skill，也可直接使用 `runtime/bin/codeflow`。若要放入用户
`PATH`，使用指向真实仓库入口的启动脚本，不要直接创建符号链接：

```bash
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\nexec "%s/runtime/bin/codeflow" "$@"\n' "$PWD" > "$HOME/.local/bin/codeflow"
chmod 755 "$HOME/.local/bin/codeflow"
```
