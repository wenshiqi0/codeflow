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

## 协议

- Goal 是可独立推进、依赖、调度和召回的结果作用域，不是步骤或角色。
- Handoff 在一个 Goal 内开启有边界的 Work Commitment。
- Receipt 以 `completed`、`partial`、`blocked`、`failed` 或 `superseded`
  关闭一个 Handoff。
- Effect 只通过 Git ref、文件路径、外部 ID、服务引用或最小语义描述引用现实状态。
- Context、tool observation、推理和 session 都不是持久语义。
- Runtime failure 只产生中断事件，不伪造 Receipt。

Root Handoff/Receipt 的语义层天然向 Child Goal 继承；当前 Goal 的本地历史天然
可见；兄弟 Goal 必须用 `recall(goal_id, level)` 显式召回。所有 Handoff/Receipt
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
recall goal
evidence run|batch|log
check source
```

Root 进程额外加载模型可见的 `goal_create`、`goal_dependencies`、
`handoff_create`、`worker_spawn`、`worker_group`；所有 Worker 都有 `receipt` 和
`recall`。Runtime 关闭 Pi 的扩展自动发现，只加载各进程显式声明的扩展，
因此 Child Worker 不会继承 Root 的 organization tools。Child Worker 每次启动
新的 Pi 进程且不传入既有 session id；完整 session 会保留为审计记录。

## 恢复语义

每次 attempt 必须先产生以下之一：

- `run_finished`：Root Handoff 已提交 Receipt；
- `run_interrupted`：Root Worker 因进程、provider、tool、取消或上下文故障退出，
  且没有 Receipt；

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
`goals/`、`handoffs/`、`events/`、`usage.jsonl` 和 `runner.json`。不存在 facts
ledger、conversation snapshot、collaboration index 或 mutable handoff state。

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
