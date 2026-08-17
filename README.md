# Codeflow

Codeflow 是一个 capability-oriented 多 Agent 编码工作流，以**单个 skill** 的形式分发。

本仓库就是这个 skill 本身：仓库根即 skill 根，clone 到宿主的 skill 目录即可使用。

## 双层 loop

Codeflow 把编码工作分成两层，两层之间只通过元数据通信：

```text
外环（宿主 Agent，读 SKILL.md）
  发起一次 run，然后阻塞等待事件；只看元数据，不进内层上下文
        │
        ▼
内环（pi agents，各自绑定不同模型）
  planner
    ├─ architect: direction / reversibility / fitness functions
    ├─ tester: business cases / executable acceptance / review
    ├─ coder: technical surface / developer tests / implementation
    └─ verify: independent execution evidence

  goal contract + test/code/verify sessions + derived join
```

- **内环**沿用 pi agents 机制与 handoff 语义：每个角色是一个独立进程，由 frontmatter 绑定自己的 provider/model，通过 handoff 移交工作单元。
- **外环**是宿主 Agent（Claude Code、opencode 等），通过 `SKILL.md` 感知协议。一次阻塞调用，绝不轮询——内环没有进展时外环不应付出任何代价。

两层各有自己的二进制，词汇表严格不相交：

| 二进制 | 受众 | 命令 |
|---|---|---|
| `codeflow` | 人 / 外环 Agent | `exec` `ls` `sub` `goals` `usage` `memo` `audit` `stop` |
| `code-agent` | 角色进程 | `delegate` `handoff` `facts` `check` `roster` |

边界由进程环境强制，而不是靠文档纪律：`code-agent` 不装在用户 PATH 上（只有 `codeflow` 拉起的子进程能看到它），且 `CODEFLOW_RUN_ID` 未设置时直接拒绝执行。外环 Agent 想手工驱动交接状态机时会得到 command not found，而不是一个半更新的 `state.json`。

铁律：**状态变更与状态查询是程序式的，需求表达与任务编排走模型与提示词。** CLI 独占状态迁移、序号分配、回执校验与事件投递；模型只写 handoff 正文、回执叙述与诊断。任何角色都不得手写状态文件。

## 目录结构

```text
SKILL.md              # 外环协议：如何发起、如何观察、何时停机
scripts/              # doctor 等运维脚本
references/           # 渐进披露：角色、模式、架构、测试与运行契约
                      # capabilities/ 是内部 role 能力提示，不暴露成宿主 skill
                      # usage.md 定义 benchmark 可读取的模型用量报告
tests/                # 每个模块一个目录，各自可独立运行
runtime/              # 内环运行时
├── agents/           #   角色定义，frontmatter 是模型绑定的唯一事实源
├── cli/              #   CLI adapter：参数解析、命令路由、输出格式
├── lib/              #   状态机、goal、事件、事实台账、usage 等核心机制
├── quality/          #   可选机械质量工具
├── extensions/       #   pi 扩展（委派、上下文、压缩、用量、活性）
├── bin/              #   codeflow（外环）+ code-agent（内环）+ pi 定位器
└── models.json       #   provider 注册表
```

`lib/` 只放核心机制，`cli/` 负责命令适配，`extensions/` 负责 Pi event/tool 适配；扩展通过 `lib/` 复用同一份状态与观测逻辑。

## 分层约束

Codeflow 的目录不是按“文件类型”随手分层，而是按**变更原因和运行边界**分层。新增文件时先问它属于哪个能力边界，再决定位置。

| 层 | 负责 | 不负责 | 典型内容 |
|---|---|---|---|
| 根 `SKILL.md` | 宿主外环协议 | 内环状态机与角色语义 | 如何 `exec`、`sub`、识别 stop signal、何时 audit |
| `scripts/` | 人工运行的环境预检和运维脚本 | 角色编排、模型提示、状态迁移 | `doctor.sh` |
| `references/` | 模型渐进读取的语义知识 | 可执行代码 | 角色、模式、架构、测试、工程风格、usage 契约 |
| `references/capabilities/` | Codeflow 内部 role 能力提示 | 宿主可发现 skill | planning / testing / implementation / verification / handoff |
| `runtime/agents/` | role 身份、模型绑定、能力描述 | CLI 参数和状态实现 | planner、architect、coder、tester、verify 及支持角色 |
| `runtime/bin/` | thin entrypoint、进程和环境边界 | 业务逻辑 | `codeflow`、`code-agent`、`pi` shim |
| `runtime/cli/` | CLI adapter | 状态规则本身 | argv 解析、命令路由、exit code、输出格式 |
| `runtime/lib/` | 可复用核心机制 | prompt 语义和 CLI 参数格式 | handoff、goal、events、facts、usage、roles、观测 |
| `runtime/quality/` | 可选机械质量工具 | 必经业务流程 | test-patch 等辅助 gate |
| `runtime/extensions/` | Pi event/tool adapter | 第二套核心状态规则 | task、context、usage、compressor、watchdog |
| `tests/` | 合同测试与回归证明 | 运行时代码 | 一个模块一个目录，mirror 被测边界 |

### 依赖方向

```text
runtime/bin
  -> runtime/cli
      -> runtime/lib
      -> runtime/quality

runtime/extensions
  -> runtime/lib
  -> references              # context extension 解析显式 import 指令
```

允许：

- CLI adapter 调用 `lib` 的公开 API；
- extension adapter 调用 `lib`，避免复制状态规则；
- `quality/` 保持独立，由 CLI 或 supervisor 显式调用；
- role prompt 用 `codeflow:import` 声明 `references/` 依赖，由 context extension 在会话开始前注入。

避免：

- `lib/` 反向 import `cli/`、`extensions/` 或 `agents/`；
- extension 自己发明第二套 handoff / goal / event 规则；
- `scripts/` 复制角色、模型或凭证映射；
- `runtime/` 内出现任何嵌套 `SKILL.md`，避免内部能力泄漏成宿主全局 skill；
- CLI adapter 承担状态 invariant；
- role prompt 描述文件系统权限或实现 CLI 状态机。

### 文件归属规则

1. **人会直接运行的环境检查** 放 `scripts/`。
2. **模型要读的知识** 放 `references/`；内部 role 专用知识放 `references/capabilities/`，并通过 `codeflow:import` 显式注入。
3. **role 身份与模型绑定** 放 `runtime/agents/*.md`。
4. **新命令或参数解析** 放 `runtime/cli/`。
5. **状态、事件、goal、facts、usage、观测的核心规则** 放 `runtime/lib/`。
6. **Pi 事件或工具接入** 放 `runtime/extensions/`。
7. **可选质量 gate** 放 `runtime/quality/`。
8. **入口壳、PATH 注入、进程边界** 放 `runtime/bin/`。
9. **防止结构回退的合同** 放 `tests/architecture/`。

`scripts/doctor.sh` 不维护第二份角色清单；它从 `runtime/models.json` 和 `runtime/agents/*.md` 推导凭证影响。角色或模型改名后 doctor 不需要手工同步。

运行时全局单份，不按项目安装。目标项目里只多出 `.codeflow/runs/`（gitignored），无需修改根 `AGENTS.md`——skill 本身就是入口。

## 测试

```bash
bun test                # 全部
bun run typecheck       # runtime TypeScript 未定义引用/类型检查
bun test tests/handoff  # 单个模块
```

测试集中在 `tests/`，每个被测模块一个目录，源码目录只放实现。约定与各目录职责见 `tests/README.md`。

## 短期上下文

多 Agent 隔离带来一个真实代价：每个角色都从零开始探索，plan 阶段已经查清的事实，coder 会再 grep 一遍。

Codeflow 分两层处理这个问题：角色用 `codeflow:import` 声明确定需要的语义知识，context extension 在会话开始前注入并记录哈希；角色确认过的事实（文件位置、接口签名、既有约定）记入当前 run 的共识区，后续角色直接读取而不是重新搜索。后者是执行期的短期上下文，不是跨项目知识库——不依赖外部记忆后端。

产品运行中的角色不探索 Codeflow 自身。运行时位置是 Pi 配置的私有细节，在工具环境可用前移除；显式引用或读取 Codeflow checkout 会被 host guard 拦截，工具输出中的残留运行时路径也会被红线处理。

## 安装

要求：macOS 或 Linux、Git、Bun 1.3+。运行时全部是 TypeScript，由 Bun 直接执行，没有构建步骤，也不需要第二个运行时。

```bash
git clone git@github.com:wenshiqi0/codeflow.git
cd codeflow
mkdir -p "$HOME/.codex/skills"
ln -s "$PWD" "$HOME/.codex/skills/codeflow"
```

安装使用符号链接而不是复制仓库：之后在这个 checkout 里 `git pull`，全局 skill 立即使用同一份最新代码，不会出现两份运行时漂移。

密钥统一从全局环境获取，仓库内不含任何凭据。在 shell 配置或全局 env 文件中提供：

```dotenv
KIMI_API_KEY=...
ZHIPU_API_KEY=...
MIMO_API_KEY=...
DEEPSEEK_API_KEY=...
```

安装后运行预检，确认依赖与密钥齐备：

```bash
./scripts/doctor.sh
```

## 与 Teamflow 的关系

Codeflow 承接 [teamflow](https://github.com/wenshiqi0/teamflow) 的执行流程——pi agents 协同与 handoff 语义原样保留。差别在交付形态：teamflow 是按项目安装的运行时，codeflow 是一个 skill，运行时全局单份，外环协议住在宿主的 skill 命名空间里而不是各项目的根 `AGENTS.md`。
