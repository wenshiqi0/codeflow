# Codeflow

Codeflow 把动态编排交给外层宿主及其 skill，把仓库工作交给 Pi 执行器。
外层使用公开的 `codeteam` 创建 Task、划分或复用 Goal、派工、跟进和收口；
内层 Pi 检查、认领和汇报自己的工作，也可调用完整的 `codeteam` 命令。
本版本暂不施加 Pi 派生禁令；同一 Task 的并发容量、session 独占和完成检查仍有效。
不预设开发/测试角色、复杂度路由或最低人数。

唯一规范是 [Collaboration semantics](docs/collaboration-semantics.md)。

## 外层编排

```text
codeteam start [--model <provider/model>] "<objective>"
codeteam goal <task> <goal-id> "<objective>" [--depends a,b]
codeteam spawn <task> [--goal <id>] "<focus>"
codeteam followup <task> <agent-id> "<focus>"
codeteam resume <task> <agent-id> "<focus>"
codeteam status <task>
codeteam inspect <task> [--goal <id> | --commitment <id> | --receipt <id>]
codeteam watch <task> [--since <seq>] [--idle <seconds>]
codeteam sub <task> [--since <seq>] [--kind <kind>,...] [--timeout <seconds>]
codeteam usage <task>
codeteam finish <task> --status completed|blocked --summary "<summary>" [--remaining "<work>"]
codeteam stop <task> [<agent-id>]
```

`start` 只创建 Task，不启动模型。外层按真实的独立工作机会调用 `spawn`，并在新证据
出现时调整派工。`followup` 只接受同一 Goal 内已 idle 的执行器，复用其 session；busy
请求直接拒绝，不隐式排队。`resume` 用于 interrupted 的原 Commitment，重新建立当前
上下文，不恢复旧推理。结果边界不变时复用 Goal，不因更换执行器而复制目标。

每个执行器自行检查仓库、创建 Commitment；Claim 记录工作归属，不是工具权限门槛。
Runtime 不因 Claim 状态拦截普通工程工具。内层
`collaborate` 只有 `inspect`、`claim`、`report`；工程辅助及 Task/Agent 控制通过 `codeteam`。
外层 focus 提供问题、交付物、证据引用及并发写入边界，不代写执行器的承诺。

派工响应直接回显 Goal/focus 原文及是否复用上下文；外层在当前对话展示这些输入。
执行中在重要发现、实现和验证节点给简短 progress 回执，不逐轮播报 usage。

观察一个 Task 时保留一个异步 `watch` 进程/会话。它持续输出有意义的 NDJSON 变化，
跨越 Agent idle 和 followup，Task 收口后退出。usage 增量按 Agent/execution 静默
延长无活动观察窗口，不让忙碌同伴掩盖另一个 Worker 的停滞；`--idle` 默认 300 秒，
无活动只提醒检查，既不是判死也不是执行超时。取消观察不停止 Worker。底层文件
通知和兜底扫描在程序内处理，不再要求模型反复调用 `sub + timeout`。`sub` 仍可用于
历史/诊断读取。宿主需要保留异步句柄；CLI 本身不能唤醒已结束的宿主对话。
`watch` 同时输出持久化的 `context_pressure` 事件：按 execution 在 50%、70%、80%
压力升级时各通知一次，携带 Pi 用量估计、窗口大小和触发阈值；80% 信号先于预算中断。
外层结合回执判断接续工作，断线后可用 `--since` 继续读取。

`progress` Receipt 保持 Commitment 开放；`completed` 和 `blocked` 关闭它。
`completed` 表示执行器交付了本轮贡献，允许记录剩余工作；外层读取回执中的实际成果、
证据和 `remaining`，决定后续分派与整体完成。执行器可在上下文仍有余量时完成回执并结束，
后续工作继续复用 Goal，选择旧 session 或新 Agent。Goal 的最新报告仍有 remaining 时，
其投影保持 pending（依赖未满足时为 waiting）。
Runtime 中断不是 Receipt。外层必须先确认全部执行器停止、没有开放 Commitment，才能
`finish` Task。Task 收口是外层记录，不伪造某个执行器的 Receipt。

外层只读取有界状态、Commitment/Receipt、事件、使用量与明确的仓库证据；不读取内层
session、transcript 或隐藏推理。复用 session 是 Runtime 的执行机制，不是观察接口。

## 单执行器基线

```bash
codeflow exec [--model <provider/model>] "<objective>"
```

`codeflow exec` 保留为 **single-executor** 入口基线：直接启动一个 Pi，
不包含外层 skill 的动态编排，也不启动隐藏 Manager；这不是 shell 派生隔离保证。`codeflow` 的
`ls/sub/goals/usage/audit/stop` 等观察与控制入口继续可用。

## SWE-bench

```bash
codeflow benchmark run --dataset <pinned-snapshot> --instances <allowlist-file> --out <new-dir>
codeflow benchmark report --run <run-dir>
```

`benchmark run` 默认测试单执行器，仍使用新工作区、数据集 allowlist 投影和官方
SWE-bench evaluator；它不是外层编排质量的测试。新结果带 `single-executor` 标识，
历史结果的方法未声明时保留 `legacy-unspecified`，不按新行为重新解释。

外层编排与官方评测通过两个无模型入口解耦：

```bash
codeflow benchmark prepare --dataset <pinned-snapshot> --instances <allowlist-file> --out <new-dir>
# prepare 返回每个 case 的 workspace 和 issue.json；每个 case 只有一个 fresh attempt。
# 外层在该 workspace 中读取允许的 issue，使用 codeteam start/spawn/followup 等完成工作。
# fix 保持未提交；确认全部执行器退出后，使用 codeteam finish 显式收口 Task。
codeflow benchmark evaluate --run <prepared-dir> --task <task-id> --model-config <outer-setup-label>
codeflow benchmark report --run <prepared-dir>
```

`prepare` 不启动模型或 evaluator；只发布四字段 issue、来源元数据及新工作区。
`evaluate` 检查 Task 所属工作区、finished 状态、全部执行器退出和原 baseline，随后
一次性冻结未提交 diff 并调用既有官方 evaluator。同一 case 不隐式重复评测或覆盖补丁；
失败的冻结/评测目录保留为证据，需要新尝试时重新 prepare。

官方 verdict 只说明候选补丁通过与否，不等于外层宿主上下文已隔离、完整成本已测量，
或取得可提交排行榜的官方分数。两阶段报告明确标记宿主上下文及网络隔离未证明、
`not_official: true`；Pi 使用量单列，外层宿主 usage 为不可得，不填零。禁止把 gold patch、
隐藏测试、官方结果或历史答案送回正在受测的执行器。

详见 [Benchmark contract](docs/benchmark-contract.md)。

## Codemark 历史报告

旧 Codemark 测量的是内层 Agent 的首次组织轮次。该 live 模式已退役：任何旧 issue、
stdin、`--model` 或 `--out` 运行方式都会明确报错，不启动模型、不创建测量产物。

```bash
codemark report --run <historical-codemark-dir>
```

此命令只读取冻结的 `initial-organization.json` v1。历史 `manager`、`manager_claim`、
`manager_progress`、`*_worker_*` 字段原样保留；模拟委派或终态不代表真实执行，更不能
作为外层 `codeteam` 编排能力的测量。

## 配置、安装与验证

`runtime/config.json` 的 `agent: { model, prompt }` 配置 Pi 执行器，内部 service 独立。
provider 来自 `runtime/models.json` 及可选本机 `runtime/providers.json`；不要提交密钥。
外层宿主模型和上下文由宿主设置，不由 Pi 的 `agent.model` 冒充。

### 固定模型的账号池

为同一 `provider/model` 注册多个账号，正常请求持续使用当前账号。遇到认证失败、余额不足、
限流、超时、网络或服务端错误时，按注册顺序尝试下一个账号；切换后的账号会继续被使用，
直到它再次报错。当前账号持久保存并由同一配置下的 Pi 进程共享。

密钥通过环境变量或 `$CODEFLOW_HOME/.env` 提供（`CODEFLOW_HOME` 默认 `~/.codeflow`）。
注册命令只接收环境变量名：

```bash
codeflow accounts add zhipuai-coding-plan/glm-5.3 main --key-env ZHIPU_API_KEY
codeflow accounts add zhipuai-coding-plan/glm-5.3 backup --key-env ZHIPU_BACKUP_API_KEY
codeflow accounts list

# 手动切换，后续请求持续使用所选账号
codeflow accounts use zhipuai-coding-plan/glm-5.3 backup
```

每次模型请求最多尝试池内每个账号一次，全部失败后报告账号池耗尽；参数、上下文和工具错误
直接报告，主动取消会停止请求。模型、会话和已完成的工具结果保留。未配置账号池的模型沿用
现有单 key 配置。账号列表与状态只展示账号标识及环境变量名。

配置文件为 `$CODEFLOW_HOME/account-pools.json`（可用 `CODEFLOW_ACCOUNT_POOLS_PATH` 指定），
格式见 [账号池示例](runtime/account-pools.json.example)。共享状态保存在
`$CODEFLOW_HOME/account-pool-state`（可用 `CODEFLOW_ACCOUNT_POOL_STATE_DIR` 指定）。
注册账号后，新启动的 Pi 进程加载配置；自动或手动切换会在现有进程的下一次请求生效。
池内请求在完整响应成功后交付文本及工具调用，失败尝试的部分输出会丢弃；等待期间的真实
生成活动仍会更新存活检查。切换原因以不含密钥的 `[codeflow:account-switch]` 记录输出。
每个账号默认允许连续 10 分钟无生成活动，超过后切换；可通过
`CODEFLOW_ACCOUNT_POOL_TIMEOUT_MS` 调整这个等待窗口（正整数，单位毫秒）。

```bash
bun install
bun run typecheck
bun test
./scripts/doctor.sh
```

仓库可作为宿主 skill 使用。公开命令包括 `codeteam`、`codeflow`、历史读取用的
`codemark`。在仓库根目录将真实 Runtime 加入当前 shell 的 PATH，不覆盖现有启动脚本：

```bash
export PATH="$PWD/runtime/bin:$PATH"
```

更新已安装 skill 时也同步其 SKILL、规范和 Runtime；旧版本的 Root-only 或递归 Pi
说明与当前外层编排不兼容。
