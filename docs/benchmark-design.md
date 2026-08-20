# Codeflow SWE-bench Verified Benchmark Design

状态：已讨论并批准进入实现
日期：2026-08-19

## 1. 目标

为 Codeflow 增加可复现的标准软件工程 benchmark 能力。第一版使用 SWE-bench Verified，正确性完全交给官方 evaluator；Codeflow 负责运行任务、生成 patch，并记录能够解释 Agent 效率的结构化指标。

第一版需要回答两个彼此独立的问题：

1. **任务是否解决**：由 SWE-bench 官方 Docker harness 判定。
2. **为得到结果消耗了什么**：记录内部 LLM model rounds、tool calls、token 和 prompt cache 指标。

不把耗时纳入主排名。wall time 仍作为运行保护和诊断 telemetry 保存。

## 2. 标准数据集与版本

- 数据集：`SWE-bench/SWE-bench_Verified`
- split：`test`
- 规模：500 instances
- 设计时固定的数据集 revision：`78f471bf655a3137b2e8a75af1501690ec009ec3`
- 官方 harness：`SWE-bench/SWE-bench`
- 设计时固定的 harness commit：`7a21e05772954cc81471ae19d56f436cecf43c54`

benchmark run manifest 必须记录实际使用的数据集 ID、split、解析后的精确 revision、harness commit/version 和 Codeflow commit。不得只记录 `main`、`latest` 或一个会移动的别名。

正式结果必须覆盖完整 500 instances。开发期先使用一份固定、可审计、不可按结果挑选的 20-instance pilot 清单验证链路；pilot 结果不能宣称为完整 SWE-bench Verified 成绩。

## 3. 数据泄漏边界

Codeflow 在执行 instance 时只能看到：

- `instance_id`；
- `repo`；
- `base_commit`；
- `problem_statement`；
- 从 `base_commit` 创建的干净代码工作区。

以下 evaluator-only 数据不得进入 Codeflow prompt、共享 facts、工具输出、工作区辅助文件或 model-visible 日志：

- gold `patch`；
- `test_patch`；
- `FAIL_TO_PASS`；
- `PASS_TO_PASS`；
- 官方 expected test results 或其他可反推出答案的字段。

实现必须通过合同测试证明 model-visible instance 是显式 allowlist 投影，而不是从完整数据记录中删除若干已知字段。

## 4. 执行协议

每个正式 instance 的主流程如下：

```text
Verified instance
  -> 从 base_commit 创建全新隔离工作区
  -> 以 problem_statement 启动一次全新 Codeflow run/session
  -> 记录 metrics ledger
  -> 到正常结束或预算停止
  -> 从工作区提取 git diff
  -> 写入官方 prediction JSONL
  -> 使用唯一 evaluation run_id 调用官方 harness
  -> 合并官方 verdict 与 Codeflow metrics
```

约束：

- 每个 instance 默认执行一次；full benchmark 不做免费 warm-up 或 cache priming。
- instance 按稳定顺序执行，默认 Agent 并发度为 1；显式并发必须写入 manifest。
- 每次执行使用新的 Codeflow run ID、session 和工作区。
- benchmark runner 不得修改数据集缓存、源 clone 或实现 Codeflow 自身的 checkout。
- 官方 harness 会按 `run_id + instance_id` 缓存评测结果。不同 patch 或不同 attempt 必须使用不同 evaluation run ID，禁止误用旧结果。
- 达到预算时停止继续推理，但仍提取当前 patch 并交给官方 evaluator；预算停止本身不直接等于 unresolved。
- provider、凭证、Docker、磁盘或 harness 基础设施故障标记为 `infra_error`，不得在同一 attempt 内静默重试，也不得伪装成模型未解决。
- Agent 工具不得使用外部网络检索答案。模型 provider 所需网络与 Agent tool 网络必须在 manifest 中分开声明；正式结果默认记录为 `tool_network: disabled`。

## 5. 公平预算

第一版对每个 instance 使用以下统一硬上限：

| 预算 | 上限 |
| --- | ---: |
| LLM model rounds | 120 |
| tool calls | 400 |
| provider-reported total tokens | 3,000,000 |
| wall time | 90 分钟 |

规则：

- 任意上限触发即停止继续执行，`terminated_by` 记录具体上限。
- wall time 只用于安全停止，不进入主得分。
- cache read/write token 包含在 provider-reported `total_tokens` 中；reasoning token 通常是 output 子集，不得再次叠加。
- 不使用费用作为停止预算或跨模型排名约束。
- pilot 后只允许在 full run 之前调整一次预算；调整理由和新值必须版本化。full run 开始后不得按模型改变预算。

## 6. Model round 口径

一个带 usage 的 assistant model response 计为一个 `model_round`。

- 一个 response 即使包含多个 tool calls，也只增加一个 model round。
- tool result 之后再次请求模型并收到 response，增加一个 model round。
- 并行模型 response 分别计数。
- planner、architect、tester、coder、verify 以及压缩或摘要等支持模型都计入 `model_rounds_total`。
- 支持模型同时单列为 `support_model_rounds`，其余列为 `primary_model_rounds`。
- provider 请求在产生 assistant response 前失败，不计 completed model round，单列为 `failed_model_attempts`。

至少提供以下维度：

- total；
- role；
- provider/model；
- goal/lane；
- primary/support；
- completed/failed attempt。

现有 usage ledger 的一条 assistant usage record 对应一个 completed model round，应复用这一事实而不是从 session transcript 推导。

## 7. Tool call 口径

模型发出的每个顶层工具调用计为一个 `tool_call`，以工具调用 ID 去重和关联。

- 一个 response 发出三个 tool calls：`model_rounds + 1`、`tool_calls + 3`。
- 重试是新的 tool call。
- 工具拒绝、执行错误和取消仍计入 total，并按状态分类。
- 一个 bash tool call 内包含多条 shell 命令仍只计一个 tool call；不得解析 shell 内容来制造子调用计数。
- 启动但在进程结束前没有 terminal result 的调用记为 `incomplete`。

至少记录：

- `tool_calls_total`；
- requested/completed/succeeded/failed/incomplete；
- by tool name；
- by role、provider/model、goal/lane；
- `tool_calls_per_model_round`；
- `tool_calls_per_resolved`。

tool metrics ledger 只允许保存调用 ID、工具名、状态、时间戳和 Codeflow 归属字段。不得保存工具参数、命令文本、源码、工具结果或凭据。

## 8. Token 与 cache 口径

每条 model usage 至少保留：

- input；
- output；
- reasoning；
- cache read；
- cache write；
- provider-reported total；
- provider-reported cost（只作信息展示，不参与公平预算或主排名）。

主汇总至少包含：

```text
tokens_per_resolved = 所有有效 attempts 的 total_tokens 之和 / resolved 数
rounds_per_resolved = 所有有效 attempts 的 model_rounds 之和 / resolved 数
tool_calls_per_resolved = 所有有效 attempts 的 tool_calls 之和 / resolved 数
```

失败但基础设施有效的 attempts 仍进入上述分子，避免“快速失败”获得虚假的效率优势。`resolved = 0` 时 per-resolved 指标为 `null`，不得除零或输出无穷大。

聚合 cache 命中率使用 token-weighted 公式，不平均各轮百分比：

```text
cache_hit_rate =
  sum(cache_read) /
  sum(input + cache_read + cache_write)
```

高 cache hit 不自动代表高效率，必须与 total/fresh input 一起展示。第一版不得把 cache 命中率直接换算成综合总分。

当前 usage normalization 会把缺失 cache 字段归零。benchmark 支持必须区分：

- provider 明确上报了 0；
- provider 没有上报或不支持该指标。

因此报告必须包含 `cache_metrics_available` 或等价的显式 availability/provenance 字段；无法确认可用时，命中率输出 `null`，不得报告为 `0%`。

## 9. 正确性与结果分类

正确性唯一权威是官方 SWE-bench Docker evaluator。Codeflow 内部 handoff PASS、goal join 或 verify receipt 只能作为诊断信息，不能替代 resolved verdict。

每个 attempt 至少区分：

- `resolved`：官方 evaluator 通过；
- `unresolved`：官方 evaluator 完成但 patch 未通过；
- `infra_error`：官方 evaluator 或执行基础设施未产生有效 verdict；
- `not_evaluated`：尚未评测。

预算停止通过独立字段 `terminated_by` 表达，可与 resolved/unresolved 同时存在。

正式 resolved rate 的分母只包含获得有效官方 verdict 的 instances。报告必须同时公开 `infra_error` 和 `not_evaluated` 数量，不能通过缩小分母隐藏缺失结果。

## 10. 产物与兼容接口

面向人和外环的入口必须通过现有 `codeflow` CLI 可发现，至少支持等价于：

```bash
codeflow benchmark run ...
codeflow benchmark report ...
```

具体参数组织可由实现决定，但必须支持：

- 官方 Verified dataset ID 或已经固定 revision 的本地 snapshot；
- instance allowlist，用于固定 pilot；
- 预算覆盖值；
- 输出目录；
- Codeflow/model 配置标识；
- dry-run/fixture 模式，使测试不依赖模型、网络或 Docker；
- 从已有 prediction/evaluation 产物重建报告，不重复调用模型。

一次 benchmark run 至少产生：

```text
benchmark-run.json       # manifest、版本、预算、配置和执行环境
predictions.jsonl        # 官方 harness 可消费的 predictions
cases/<instance>/...     # attempt status 与结构化 metrics
report.json              # 机器可读总报告
```

`predictions.jsonl` 必须符合官方字段合同，至少包含：

- `instance_id`；
- `model_name_or_path`；
- `model_patch`。

所有新产物需要 `schema_version`。写入使用原子替换或 append-only ledger，保证并发或中断后不会把半个 JSON 当成有效结果。

## 11. 汇总与展示

第一版不产生主观加权综合分。报告先按正确性 gate，再展示效率维度和 Pareto 信息。

suite 级别至少展示：

- resolved / unresolved / infra_error / not_evaluated；
- resolved rate；
- total、median、P90 model rounds；
- total、median、P90 tool calls；
- total、median、P90 token；
- rounds/tool calls/tokens per resolved；
- cache read/write 与 token-weighted hit rate；
- 按 role、model、goal/lane、tool name 的分解；
- budget termination counts；
- wall time telemetry，但明确标注 `not_ranked`。

不同 Codeflow/model 配置只有在 dataset revision、instance set、预算、网络策略和 evaluator version 相同的情况下才可直接比较。报告必须输出这些比较键。

## 12. 非目标

第一版不负责：

- 自定义私有 benchmark 数据集；
- SWE-bench Multimodal 或其他非 Verified suite；
- leaderboard 提交；
- 用时间或费用生成综合分；
- 解析 session transcript、tool 参数或 shell 命令来补指标；
- 在单元测试中下载 500 instances、拉取大型 Docker 镜像或发起真实模型调用；
- 把 pilot 结果包装成正式 Verified 成绩。

## 13. 验收标准

实现完成需同时满足：

1. `codeflow --help` 可发现 benchmark 能力，未知参数有稳定非零退出码。
2. 使用小型 SWE-bench fixture 和 fake Codeflow/evaluator 可离线完成 run -> patch -> prediction -> verdict -> report 全链路。
3. allowlist 投影测试证明 gold/evaluator-only 字段不会进入 model-visible 输入。
4. model round 计数覆盖多角色、支持模型和失败 attempt。
5. tool call 计数覆盖一个 response 多调用、成功、失败、拒绝和 incomplete；ledger 不包含参数与结果。
6. token/cache 测试覆盖“明确 0”和“未上报”的区别，以及 token-weighted cache hit。
7. 三种资源预算与 wall-time 安全停止均有确定性测试；停止后仍提取并评测当前 patch。
8. prediction JSONL 可被官方字段合同接受；不同 attempt 生成不同 evaluation run ID。
9. report 的失败消耗进入 per-resolved 分子，infra_error 数量不会被隐藏。
10. 原有 Codeflow exec/resume/ls/sub/goals/usage/audit/stop 行为保持兼容。
11. 通过仓库要求的 source safety、针对性测试、完整 `bun test`、`bun run typecheck` 和 `git diff --check`。
12. 不依赖读取 `.codeflow/runs/` 中的 session transcript 或模型 prose。

## 14. 实施边界

实现应复用现有 usage、run lifecycle、goal/handoff attribution 和外环 CLI 机制。benchmark 是新的数据集适配、运行控制和报告能力，不应复制第二套 Codeflow 状态机。

实现者可以调整内部模块边界，但不得削弱本文件的数据泄漏、公平预算、权威 evaluator、隐私和兼容性要求。若官方 live evaluator 因本机 Docker/架构/磁盘条件不能运行，应明确报告为未执行的外部验证，不得以 fixture 测试冒充完整官方验证。
