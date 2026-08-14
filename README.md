# Codeflow

Codeflow 是一个 test-first 多 Agent 编码工作流，以**单个 skill** 的形式分发。

本仓库就是这个 skill 本身：仓库根即 skill 根，clone 到宿主的 skill 目录即可使用。

## 双层 loop

Codeflow 把编码工作分成两层，两层之间只通过元数据通信：

```text
外环（宿主 Agent，读 SKILL.md）
  发起一次 run，然后阻塞等待事件；只看元数据，不进内层上下文
        │
        ▼
内环（pi agents，各自绑定不同模型）
  planner → test-writer → test-runner(RED) → coder → test-runner(GREEN) → review
```

- **内环**沿用 pi agents 机制与 handoff 语义：每个角色是一个独立进程，由 frontmatter 绑定自己的 provider/model，通过 handoff 移交工作单元。
- **外环**是宿主 Agent（Claude Code、opencode 等），通过 `SKILL.md` 感知协议。一次阻塞调用，绝不轮询——内环没有进展时外环不应付出任何代价。

两层各有自己的二进制，词汇表严格不相交：

| 二进制 | 受众 | 命令 |
|---|---|---|
| `codeflow` | 人 / 外环 Agent | `exec` `ls` `sub` `memo` `audit` `stop` |
| `code-agent` | 角色进程 | `delegate` `handoff` `facts` `check` `roster` |

边界由进程环境强制，而不是靠文档纪律：`code-agent` 不装在用户 PATH 上（只有 `codeflow` 拉起的子进程能看到它），且 `CODEFLOW_RUN_ID` 未设置时直接拒绝执行。外环 Agent 想手工驱动交接状态机时会得到 command not found，而不是一个半更新的 `state.json`。

铁律：**状态变更与状态查询是程序式的，需求表达与任务编排走模型与提示词。** CLI 独占状态迁移、序号分配、回执校验与事件投递；模型只写 handoff 正文、回执叙述与诊断。任何角色都不得手写状态文件。

## 目录结构

```text
SKILL.md              # 外环协议：如何发起、如何观察、何时停机
scripts/              # doctor 等运维脚本
references/           # 渐进披露：handoff 契约、事实台账、角色与模型绑定
tests/                # 每个模块一个目录，各自可独立运行
runtime/              # 内环运行时
├── agents/           #   角色定义，frontmatter 是模型绑定的唯一事实源
├── lib/              #   状态机、事实台账、序号分配、CLI（TypeScript）
├── extensions/       #   pi 扩展（委派、上下文、活性）
├── bin/              #   codeflow（外环）+ code-agent（内环）+ pi 定位器
└── models.json       #   provider 注册表
```

`lib/` 里的模块既是 CLI 实现，也被扩展直接 import——同一份逻辑只有一个实现，不存在跨语言副本漂移。

运行时全局单份，不按项目安装。目标项目里只多出 `.codeflow/runs/`（gitignored），无需修改根 `AGENTS.md`——skill 本身就是入口。

## 测试

```bash
bun test                # 全部
bun test tests/handoff  # 单个模块
```

测试集中在 `tests/`，每个被测模块一个目录，源码目录只放实现。约定与各目录职责见 `tests/README.md`。

## 短期上下文

多 Agent 隔离带来一个真实代价：每个角色都从零开始探索，plan 阶段已经查清的事实，coder 会再 grep 一遍。

Codeflow 用 **run 内的共享事实缓存**解决这个问题：角色确认过的事实（文件位置、接口签名、既有约定）记入当前 run 的共识区，后续角色直接读取而不是重新搜索。这是执行期的短期上下文，不是跨项目知识库——不依赖外部记忆后端。

## 安装

要求：macOS 或 Linux、Git、Bun 1.3+。运行时全部是 TypeScript，由 Bun 直接执行，没有构建步骤，也不需要第二个运行时。

```bash
git clone git@github.com:wenshiqi0/codeflow.git
```

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
