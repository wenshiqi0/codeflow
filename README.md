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

- **内环**沿用 pi agents 机制与 handoff 语义：每个角色是一个独立进程，由 `runtime/roles.json` 绑定 provider/model 和唯一 capability prompt，通过 handoff 移交工作单元。
- **外环**是宿主 Agent（Claude Code、opencode 等），通过 `SKILL.md` 感知协议。一次阻塞调用，绝不轮询——内环没有进展时外环不应付出任何代价。

两层各有自己的二进制，词汇表严格不相交：

| 二进制 | 受众 | 命令 |
|---|---|---|
| `codeflow` | 人 / 外环 Agent | `exec` `resume` `ls` `sub` `goals` `usage` `memo` `audit` `stop` |
| `code-agent` | 角色进程 | `delegate` `handoff` `facts` `check` `roster` |

边界由进程环境强制，而不是靠文档纪律：`code-agent` 不装在用户 PATH 上（只有 `codeflow` 拉起的子进程能看到它），且 `CODEFLOW_RUN_ID` 未设置时直接拒绝执行。外环 Agent 想手工驱动交接状态机时会得到 command not found，而不是一个半更新的 `state.json`。

铁律：**状态变更与状态查询是程序式的，需求表达与任务编排走模型与提示词。** CLI 独占状态迁移、序号分配、回执校验与事件投递；模型只写 handoff 正文、回执叙述与诊断。任何角色都不得手写状态文件。

## 启动与续跑

```bash
codeflow exec "<requirement>"
codeflow resume <run-id>
```

`exec` 创建新 run；`resume` 只续跑一个已经完全停止的既有 run。续跑沿用同一 run id、原始 requirement、planner session、goal/lane sessions、facts 和 evidence，并创建下一条 depth-0 planner handoff；已经终态的 handoff 不会重开。

只有最新 attempt 已按顺序产生 `run_finished` 和 `runner_exited` 时才能 `resume`，避免同一 run 中出现两个 root planner。该命令只能由人或外环显式调用，不会自动重试，也不能从另一个 Codeflow run 内调用。

## 目录结构

```text
SKILL.md              # 外环协议：如何发起、如何观察、何时停机
scripts/              # doctor 等运维脚本
references/           # 角色能力提示与运行契约
                      # capabilities/ 是每个 role 的唯一系统提示，不暴露成宿主 skill
                      # usage.md 定义 benchmark 可读取的模型用量报告
tests/                # 每个模块一个目录，各自可独立运行
runtime/              # 内环运行时
├── roles.json        #   角色注册表：模型、prompt、工具、上下文、lane
├── cli/              #   CLI adapter：参数解析、命令路由、输出格式
├── lib/              #   状态机、goal、事件、事实台账、usage 等核心机制
├── quality/          #   可选机械质量工具
├── extensions/       #   pi 扩展（provider、委派、上下文、压缩、用量、活性）
├── bin/              #   codeflow（外环）+ code-agent（内环）+ pi 定位器
├── models.json       #   固定 endpoint 的 Pi provider 注册表
└── providers.json.example # 本地动态 provider 配置模板
```

`lib/` 只放核心机制，`cli/` 负责命令适配，`extensions/` 负责 Pi event/tool 适配；扩展通过 `lib/` 复用同一份状态与观测逻辑。

## 分层约束

Codeflow 的目录不是按“文件类型”随手分层，而是按**变更原因和运行边界**分层。新增文件时先问它属于哪个能力边界，再决定位置。

| 层 | 负责 | 不负责 | 典型内容 |
|---|---|---|---|
| 根 `SKILL.md` | 宿主外环协议 | 内环状态机与角色语义 | 如何 `exec`、`sub`、识别 stop signal、何时 audit |
| `scripts/` | 人工运行的环境预检和运维脚本 | 角色编排、模型提示、状态迁移 | `doctor.sh` |
| `references/` | 角色语义与运行契约 | 可执行代码和模型绑定 | capability prompts、handoff、goal、facts、usage |
| `references/capabilities/` | 每个 Codeflow role 的唯一系统提示 | 宿主可发现 skill、重复的 agent prompt | planning / architecture / testing / implementation / verification / support |
| `runtime/roles.json` | role 注册、模型与运行策略 | 行为提示词和状态实现 | prompt 路径、tool allowlist、context、lane、delegation |
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
  -> runtime/roles.json
  -> references              # 加载 role prompt；可解析显式 import 指令
```

允许：

- CLI adapter 调用 `lib` 的公开 API；
- extension adapter 调用 `lib`，避免复制状态规则；
- `quality/` 保持独立，由 CLI 或 supervisor 显式调用；
- role registry 指向 `references/capabilities/` 下的唯一 prompt；必要时 prompt 可用 `codeflow:import` 声明额外参考。

避免：

- `lib/` 反向 import `cli/` 或 `extensions/`；
- extension 自己发明第二套 handoff / goal / event 规则；
- `scripts/` 复制角色、模型或凭证映射；
- `runtime/` 内出现任何嵌套 `SKILL.md`，避免内部能力泄漏成宿主全局 skill；
- CLI adapter 承担状态 invariant；
- role prompt 描述文件系统权限或实现 CLI 状态机。

### 文件归属规则

1. **人会直接运行的环境检查** 放 `scripts/`。
2. **模型要读的行为提示** 放 `references/capabilities/`，每个 role 保留一份完整 prompt；共享运行契约放 `references/`。
3. **role 身份、模型、prompt 路径和运行策略** 只放 `runtime/roles.json`。
4. **新命令或参数解析** 放 `runtime/cli/`。
5. **状态、事件、goal、facts、usage、观测的核心规则** 放 `runtime/lib/`。
6. **Pi 事件或工具接入** 放 `runtime/extensions/`。
7. **可选质量 gate** 放 `runtime/quality/`。
8. **入口壳、PATH 注入、进程边界** 放 `runtime/bin/`。
9. **防止结构回退的合同** 放 `tests/architecture/`。

`scripts/doctor.sh` 不维护第二份角色清单；它从 `runtime/models.json`、本地 `runtime/providers.json`（如果存在）和 `runtime/roles.json` 推导 endpoint/凭证影响。角色或模型改名后 doctor 不需要手工同步。

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

Codeflow 分两层处理这个问题：每个角色从一份精准的 capability prompt 启动，必要的额外参考才用 `codeflow:import` 注入并记录哈希；角色确认过的事实（文件位置、接口签名、既有约定）记入当前 run 的共识区，后续角色直接读取而不是重新搜索。后者是执行期的短期上下文，不是跨项目知识库——不依赖外部记忆后端。

角色可通过 `$PI_CODING_AGENT_DIR` 直接定位 Codeflow 运行时，其父目录是已安装的 Codeflow Skill 根目录；遇到编排自身的异常时可以检查实现。业务 run 内这两个目录保持只读，host guard 会终止任何写入或变更命令，避免诊断过程污染正在使用的运行时。

## 安装

要求：macOS 或 Linux、Git、Bun 1.3+。运行时全部是 TypeScript，由 Bun 直接执行，没有构建步骤，也不需要第二个运行时。

仓库根就是 skill 根。正常使用时直接把仓库 clone 到宿主的全局 skills 目录：

| 宿主 | 常规全局 skills 目录 |
|---|---|
| Codex | `$HOME/.codex/skills` |
| OpenCode | `$HOME/.config/opencode/skills` |
| Claude Code | `$HOME/.claude/skills` |

以 Codex 为例：

```bash
skills_dir="$HOME/.codex/skills"
mkdir -p "$skills_dir"
codeflow_root="$skills_dir/codeflow"
git clone git@github.com:wenshiqi0/codeflow.git "$codeflow_root"

printf '是否将 codeflow 命令安装到用户全局？ [y/N] '
IFS= read -r install_codeflow_cli
case "$install_codeflow_cli" in
  [yY]|[yY][eE][sS])
    user_bin="$HOME/.local/bin"
    mkdir -p "$user_bin"
    printf '#!/bin/sh\nexec "%s/runtime/bin/codeflow" "$@"\n' "$codeflow_root" > "$user_bin/codeflow"
    chmod 755 "$user_bin/codeflow"
    echo "installed: $user_bin/codeflow"
    case ":$PATH:" in
      *":$user_bin:"*) ;;
      *) echo "请将 $user_bin 加入 PATH 后重新打开终端" ;;
    esac
    ;;
  *)
    echo '跳过全局命令安装；仍可通过 runtime/bin/codeflow 使用'
    ;;
esac
```

其他宿主替换 `skills_dir` 为上表中的对应目录即可；若宿主还支持项目级 skills 目录，也可以按其约定放置。

全局命令安装是可选的，只把面向人和宿主 Agent 的 `codeflow` 放入用户 PATH；内部 `code-agent` 仍只在 run 内可见。这里使用启动器而不是直接创建符号链接，因为入口需要从真实脚本位置定位同目录下的运行时。若之后移动 skill 目录，请在新目录重新执行这一安装步骤。

密钥统一从全局环境获取，仓库内不含任何凭据。在 shell 配置或全局 env 文件中提供：

```dotenv
KIMI_API_KEY=...
ZHIPU_API_KEY=...
MIMO_API_KEY=...
DEEPSEEK_API_KEY=...
```

如果需要接入 base URL 由环境变量提供的自定义 provider，先复制模板：

```bash
cp runtime/providers.json.example runtime/providers.json
```

`runtime/providers.json` 是本机动态 provider 注册表：它定义 provider ID、协议、模型元数据，以及 base URL/API key 对应的环境变量名。该文件已被 Git 忽略，便于每台机器保持独立路由；真实 URL 和密钥仍只放在 shell 环境或全局 env 文件中，不写入 JSON。未创建该文件时，Codeflow 仅使用仓库内置的 `runtime/models.json`。要让角色使用自定义模型，将 `runtime/roles.json` 中的绑定写为 `<provider-id>/<model-id>`。

安装后运行预检，确认依赖与密钥齐备：

```bash
./scripts/doctor.sh
```
