# Design C — 副作用隔离、上下文外置与 tester 轮次收敛

状态：待评审
基线：`main`（含 Design A 的 A1 / A2.1 / A2.2 / A3.1 / A3.4 已落地部分）
证据基线：2026-08 SWE-bench Verified 20-case run（13 evaluated / 3 resolved；
astropy-13453、astropy-14539、astropy-7606）
分支建议：`perf/hygiene-context-tester`，按 C1 / C2 / C3 / C4 四个 PR 递进
关系：与 Design A 正交——A2.1 解决的是**注入块**的重复（规则 + facts），
本设计解决的是 **tool result 历史**与**副作用产物**两类更大的体量来源；
度量沿用 Design B 的 B3/B4 仪表盘与 `tokens-cache` 口径。

## 0. 问题定位（从 3 个成功 case 的证据出发）

| 现象 | 根因 | 归属 PR |
|---|---|---|
| patch 混入 `.codeflow/` evidence、`*.bak`、FITS 二进制（13453: 7 文件中 5 个噪音；14539: 19 文件；7606: 16 文件） | `runtime/AGENTS.md` 用相对路径 "below `.codeflow/runs/`"，角色 cwd 是目标仓库，产物落进工作树；`extractPatch` 是 `git add -A` 全收 | C1 |
| tester 43–62 rounds、1.1M–2.5M tokens，是三个 case 无一例外的最大消耗源 | tester 走裸 bash 跑 pytest，全量输出进上下文（>16KB 才触发 zipper 且压缩后仍 ~16KB）；`testing.md` 未引入 evidence recorder；review 职责让 tester 重入重读 | C2 |
| 3M total_tokens 被 cache-read 撑爆（hit rate 94.75%–97.11%），15/20 case 截断，13453/7606 收尾被砍 | lane session 持久 + compaction 被 cancel ⇒ 每轮重放全部历史 tool result；预算只有 total_tokens 一根轴，把 cache 重放和新鲜产出混在一起计量 | C3 / C4 |

非目标（与 Design A §0 一致）：

- 不改 handoff 状态机、封闭 reason 枚举、receipt 契约；
- 不引入模型不可见的注入；compaction 禁令不动摇——C3 的外置是**无损、
  确定性、可取回**的，不是摘要；
- 不为省 token 弱化"业务命令永不隐式重试"。

---

## PR C1 — 副作用产物隔离与 patch 卫生（纯 benchmark/指令层，零运行时风险）

### C1.1 workspace 播种 `.git/info/exclude`

**改动**（`benchmark/lib/workspace.ts`）：
新增 `seedBenchmarkWorkspaceHygiene(dir)`。`prepareBenchmarkWorkspace` 在
`git init` 后调用；real-mode `runner.ts` 在 `workspaceProvisioner` 克隆/检出成功后
也调用同一 helper（real workspace 不走 fixture 初始化路径，不能只覆盖 offline mode）。
helper 写入 `.git/info/exclude`：

```
.codeflow/
codeflow-runs/
*.bak
*.orig
*.rej
```

`info/exclude` 不进工作树、不进 diff。副带收益：模型在 run 中执行
`git status` / `git diff` 时不再看到这些噪音——这本身是一块反复流入
上下文的副作用文本。

**明确不做**：不 exclude `*.fits` 等数据后缀。二进制污染由 C1.2 的
提取层兜底处理，避免误伤仓库内合法的测试数据变更。

### C1.2 `extractPatch` 提取层过滤 + 二进制 hunk 门

**改动**（同文件 `extractPatch`）：

1. diff 加 exclude pathspec（对 C1.1 的双保险，覆盖角色显式
   `git add -f` 的情况）：
   `git diff --cached --binary HEAD -- . ':(exclude).codeflow' ':(exclude)codeflow-runs' ':(exclude)*.bak' ':(exclude)*.orig' ':(exclude)*.rej'`
2. 扫描结果中的 `GIT binary patch` 标记：出现即按文件段剥离该 hunk，
   并返回结构化结果 `{ patch, strippedBinaryPaths: string[] }`；
   `runner.ts` 把 `strippedBinaryPaths` 记入 attempt 元数据
   （B3 报告可见），prediction 只带剥离后的文本 patch。
   SWE-bench Verified 全部是 Python 仓库，合法修复不需要二进制变更；
   剥离是安全的，且留下了审计痕迹。

**兼容**：`extractPatch(dir)` 的字符串返回签名保留（内部调新函数），
`tests/benchmark/predictions.test.ts:91-100` 既有的空 patch / 幂等断言
不修改、必须继续绿。

### C1.3 产物路径从相对指令改为绝对 env

**改动**：

1. `role-launcher.ts` 的 `childEnv` 注入
   `CODEFLOW_EVIDENCE_DIR = <RunPaths.evidence 绝对路径>`
   （`RunPaths.evidence` 已存在：`<runsRoot>/evidence/<run-id>`；
   benchmark 模式下 `CODEFLOW_RUNS_DIR` 在 workspace 外，因此该路径
   天然在目标仓库外）；
2. `runtime/AGENTS.md` Engineering rules 中
   "Put temporary run artifacts below `.codeflow/runs/`" 改为
   "Put temporary run artifacts, reproduction scripts, and generated data
   below `$CODEFLOW_EVIDENCE_DIR` — never inside the target repository's
   working tree"；
3. `references/capabilities/testing.md` / `implementation.md` 中
   "goal's test/code evidence root" 显式定义为
   `$CODEFLOW_EVIDENCE_DIR/<goal-id>/<lane>/`。

### C1 测试点（锁定）

新文件 `tests/benchmark/patch-hygiene.test.ts`：

| # | 断言 |
|---|---|
| C1-T1 | 准备 workspace 后写入 `.codeflow/runs/x/receipt.json`、`a.py.bak`、`fix.orig`，并正常修改 `a.py`；`extractPatch` 结果**只含** `a.py` 的 hunk |
| C1-T2 | 同一工作树内 `git status --porcelain` 输出不含 `.codeflow/`、`*.bak`（`info/exclude` 生效，即模型可见的 status 干净） |
| C1-T3 | 角色用 `git add -f .codeflow/evil.txt` 强制加入后，`extractPatch` 仍不含该路径（pathspec 兜底） |
| C1-T4 | 写入一个二进制文件（含 NUL 字节）+ 一个文本修改；返回的 `patch` 无 `GIT binary patch` 标记、文本 hunk 完整保留；`strippedBinaryPaths` 恰含该二进制路径 |
| C1-T5 | 仓库内合法的纯文本数据文件修改（如 `.fits` 后缀但无 NUL 的头文本）不被剥离（按内容判定，不按后缀误伤） |
| C1-T6 | 空变更 → `""`；重复提取幂等（继承 `predictions.test.ts:91-100` 语义，且在启用 exclude 后仍成立） |

新文件 `tests/directory-policy/evidence-dir.test.ts`（该目录已存在同主题套件）：

| # | 断言 |
|---|---|
| C1-T7 | `runRoleChild` 构造的 `childEnv.CODEFLOW_EVIDENCE_DIR` 是绝对路径，且当 `CODEFLOW_RUNS_DIR` 指向 workspace 外时，该路径不以 workspace cwd 为前缀 |
| C1-T8 | 契约测试：`runtime/AGENTS.md` 不再含 "below \`.codeflow/runs/\`" 的产物指令原文，含 `$CODEFLOW_EVIDENCE_DIR`；`testing.md`、`implementation.md` 的 evidence root 定义指向同一 env（grep 级断言，防止 prompt 回归） |

验收指标（B3 报告）：重跑 3 个成功 case，`model_patch` 文件数
13453: 7→≤2、14539: 19→≤2、7606: 16→≤2（只剩生产代码 + 必要测试文件）。

---

## PR C2 — tester 轮次收敛（recorder 优先 + 测试策略收窄 + review 下放）

> 三个成功 case 中 tester 占 tokens 的 55%–85%。本 PR 是单点收益最大的
> 一条，且 C2.1/C2.3/C2.4 为纯 prompt/文档改动，可独立回滚。

### C2.1 tester 改走 evidence recorder（prompt 层）

**现状**：`command-evidence.ts` 已实现"完整 stdout/stderr 落盘、上下文
只留 receipt 行 + `stdout_ref`"，但只有 `verification.md` 教了用法；
tester 在裸 bash 里跑 pytest，每次最多 16KB（zipper 压缩后仍是 16KB 顶）
进入持久 session，之后每一轮重放。

**改动**（`references/capabilities/testing.md`）：测试执行一律
`code-agent evidence run --id <case-id> -- <runner command>`；bash 保留给
文件探查与 grep。每次测试在上下文中的驻留成本从 ~16KB 降到一行
receipt（~200B），失败时按 `stdout_ref` / C3.2 的 `evidence log`
精确回读失败段。

### C2.2 recorder 幂等去重（机制层，本 PR 唯一的 runtime 改动）

**改动**（`runtime/lib/command-evidence.ts`）：`runCommandEvidence` 执行前
计算 key：

```
key = sha256(
  argv.join('\0') + '\0' + rev-parse HEAD + '\0'
  + git status --porcelain=v1 输出 + '\0'
  + git diff --binary HEAD 输出 + '\0'
  + tracked/untracked path 与文件内容摘要
)
```

（只读 git 命令 + 当前文件内容摘要；`git status` 只能看到路径状态，不能证明
同一 ` M path` 的内容未变。非 git 目录取到任一失败 ⇒ 去重整体禁用。）
命中同 key 的既有 record 时：

- 不重新执行；返回既有 record 的副本并标 `deduped: true`、
  `deduped_from: <原 id>`；
- receipt 聚合时 `deduped` 条目保留原 `exit_code` / `status`，不重复计数。

**哲学边界**：这不违反"无隐式重试"——被去掉的是**重放一个已有记录的
相同命令于完全相同的工作树**，它不产生任何新证据；工作树一旦变化
（status 任一行变了）key 即失效，照常执行。修复必然改变工作树，因此
dedupe 永远不会掩盖"修复后复验"。逃生阀：`--no-dedupe` flag +
`CODEFLOW_EVIDENCE_DEDUPE=off`。

### C2.3 测试策略收窄（prompt 层）

`testing.md` 增补三条硬规则：

1. tester lane 只跑**单个 test node id**（如
   `pytest path::test_case -x -q --no-header`）；禁止在 tester lane 跑
   目录级或全量套件；
2. 全量回归归 `verify` 所有，且每 goal 至多一次（astropy-7606 的
   240 个 PASS_TO_PASS 若 tester 也跑过，即纯浪费）；
3. 同一 handoff 内不得重跑已有 receipt 的相同命令（C2.2 机械 enforce，
   prompt 先行声明意图）。

### C2.4 review 职责下放 verify（prompt 层）

**现状**：`testing.md` 的 "On review, assess the business tests, developer
tests, diff, and verify receipts as one evidence story" 使 tester 在实现
后被叫回——旧 session 全量重放 + 重读 diff/receipt，是一整段昂贵重入。

**改动**：

- `testing.md` 删除 review 段，改为 "assertion-intent consultation only:
  return when the planner explicitly disputes assertion intent"；
- `verification.md` 已含 "Inspect the final diff and checkpoint chain for
  … weakened assertions, ineffective tests"——补一句显式承接
  "including whether business assertions still express the tester's
  recorded intent"（verify 跑在 deepseek flash 上，单价与轮次成本远低于
  tester 的 glm-5.3 长 session）；
- `planning.md` 的 capability composition 表更新路由：
  "post-implementation evidence review -> `verify`; re-engage `tester`
  only for disputed assertion intent"。

### C2 测试点（锁定）

`tests/evidence/command-evidence.test.ts` 增补：

| # | 断言 |
|---|---|
| C2-T1 | 同一 argv、工作树未变，连续两次 `runCommandEvidence`：副作用命令（向文件追加一行）只执行一次；第二次返回 `deduped: true` 且 `exit_code`/`status` 与第一次一致 |
| C2-T2 | 两次调用之间修改 tracked/untracked 内容 → 第二次真实执行（副作用目标必须在 workspace 外） |
| C2-T3 | FAIL（exit≠0）记录同样参与 dedupe：工作树未变时重跑命中缓存返回原 FAIL 记录；修复（工作树变化）后 key 失效、真实重跑——锁定"dedupe 不掩盖修复验证"的语义 |
| C2-T4 | `--no-dedupe` 与 `CODEFLOW_EVIDENCE_DEDUPE=off` 均绕过缓存、真实执行 |
| C2-T5 | 非 git 目录（无 HEAD）→ 去重静默禁用，行为与现状逐字节一致 |
| C2-T6 | `deduped` 条目进入 `evidence receipt` 聚合时不重复计数，`receipts[]` 保留 `deduped_from` |

新文件 `tests/roles/capability-contract.test.ts`（prompt 回归锁）：

| # | 断言 |
|---|---|
| C2-T7 | `testing.md` 含 `code-agent evidence run`；含单 test node id 规则关键句；不含 "On review, assess" 原句 |
| C2-T8 | `verification.md` 含 assertion-intent 承接句；`planning.md` 路由表含 "post-implementation evidence review -> `verify`" |
| C2-T9 | `testing.md` 含 "full regression … belongs to `verify` … at most once per goal" 关键句 |

验收指标（B4 仪表盘，重跑 3 case 对照）：tester rounds 43–62 → 目标
≤25；tester tokens 占比 55–85% → 目标 ≤40%；`support_model_rounds`
中 zipper 调用次数显著下降（tester 不再产出 >16KB bash 结果）。

---

## PR C3 — 上下文确定性外置（eviction + 取回通道 + handoff 指针化）

> 这是治"3M 被 cache-read 撑爆"的根。前提共识：compaction 禁令不变——
> 有损摘要产出无证据的自信。但**把旧 tool result 原文移到磁盘、上下文里
> 留可取回指针**不是 compaction：不经过模型、零内容丢失、hash 可审计。
> 与 A2.1 的 manifest-hash 哲学同构：正文外置，指针留痕。

### C3.1 tool-result eviction

**机制**（`runtime/extensions/codeflow-context`，新模块 `eviction.ts`）：

- 作用面：**provider 请求的 payload 组装层**，不是磁盘 session 文件。
  on-disk transcript 保持完整原文（审计契约不变）；eviction 只改变
  重放给 provider 的历史消息内容。实现挂在 pi 的 context 组装 seam
  （与 `ctx.sessionManager.buildContextEntries()` 同层的 transform
  hook；若当前 pi 版本无此 hook，先在 pi-coding-agent 侧补 hook，作为
  本 PR 的前置 task——**不做**监听+改写磁盘 session 文件的旁路方案）；
- 策略（纯函数进 `eviction.ts`，便于单测）：
  - 候选：`tool_result` 类历史条目，字节数 > `EVICT_MIN_BYTES`（默认
    4KB）且距今超过 `EVICT_AFTER_ROUNDS`（默认 8 轮）；
  - 保护：最近 N 轮全保留；当前 handoff 开启后的条目全保留；
    含 `code-agent handoff` / `code-agent evidence` CLI 输出的条目
    全保留（状态转移证据，且本来就小）；
  - 替换文本（确定性、byte-stable，服从 A1.1 的缓存前缀稳定原则）：
    `[archived tool result: sha256=<h> bytes=<n> ref=<evidence 相对路径>; retrieve with: code-agent evidence log <id>]`
  - 原文写 `$CODEFLOW_EVIDENCE_DIR/tool-log/<session>/<entry-id>.txt`，
    原子写入（沿用 `writeJsonAtomic` 同族原语）。
- 开关：`CODEFLOW_CONTEXT_EVICTION=off`（pilot 对照用），默认 on。

**与 prompt cache 的交互**：eviction 发生在历史前缀上，会使该请求的
cache 前缀失效一次，之后重新稳定。策略必须**单调**：一个条目一旦被
evict，之后每轮都以同一指针文本出现（不会抖动回原文），失效只发生
一次。单测锁定（C3-T4）。

### C3.2 取回通道 `code-agent evidence log`

**改动**（`runtime/cli/evidence.ts`）：新增子命令
`code-agent evidence log <id> [--head N|--tail N|--grep <pattern>]`，
从 tool-log / recorder 归档读回；默认输出 head+tail 各 2KB，`--grep`
返回匹配行±3 行——**取回本身不能成为新的上下文炸弹**。

**指令契约**（`runtime/AGENTS.md`）：现行 "Never grep, cat, tail, or
otherwise content-scan `.codeflow/runs/`" 与归档取回冲突，增补 carve-out：
"Archived tool logs are the one exception: retrieve them only through
`code-agent evidence log`, never by reading the files directly." CLI 是
唯一合法通道，直接读文件仍被禁止（保住 run 目录不被自由扫描的边界）。

### C3.3 lane 续跑 handoff 正文指针化

**现状**：handoff body ≤4,000 字符经 `task` 工具 prompt 传入，之后作为
session 历史被每轮重放；lane 第 N 个 handoff 的 session 里躺着 N 份正文。

**改动**：

1. `runtime/cli/handoff.ts` 新增 `code-agent handoff body --id <id>`，
   打印 `handoffs/<id>/handoff.md` 原文（`open` 时正文本来就落盘）；
2. `codeflow-task/registry.ts`：lane session **续用**（非首个 handoff）
   时，传给子进程的 prompt 改为
   `handoff <id> opened for goal <goal-id> lane <lane>: <title 一行>。
   Read the full contract with: code-agent handoff body --id <id>`；
   lane 首个 handoff 与 `--no-session` 角色（architect）不变，仍传全文
   ——新 session 没有"历史重放"问题，指针反而多一轮工具调用；
3. `planning.md` 不变（planner 仍写全文，落盘由 `open` 完成）。

### C3 测试点（锁定）

新文件 `tests/context/eviction.test.ts`（纯函数层）：

| # | 断言 |
|---|---|
| C3-T1 | 构造 20 轮假 entries（含 3 条 >4KB 的旧 tool result、1 条最近轮次的大结果、1 条含 `code-agent handoff finish` 输出的旧大结果）：恰好前 3 条被选中 |
| C3-T2 | 替换文本含正确 sha256、字节数、ref；归档文件内容与原文逐字节一致 |
| C3-T3 | `EVICT_MIN_BYTES` 边界：恰等于阈值不 evict，阈值+1 evict；`EVICT_AFTER_ROUNDS` 边界同理 |
| C3-T4 | 单调性：对同一 session 连续两次组装，第一次被 evict 的条目第二次产出**逐字节相同**的指针文本（缓存前缀只失效一次） |
| C3-T5 | `CODEFLOW_CONTEXT_EVICTION=off` → 原文全保留，输出与现状逐字节一致 |
| C3-T6 | 归档写失败（目录只读）→ 该条目**不 evict**（宁可花 token 不可丢证据），且不抛错中断组装 |

`tests/cli-run` / `tests/evidence` 增补：

| # | 断言 |
|---|---|
| C3-T7 | `evidence log <id>` 默认输出 ≤4KB+省略标记；`--grep` 返回匹配行±3 行；不存在的 id → 非零退出 + 单行错误 |
| C3-T8 | `handoff body --id` 输出与 `open` 时落盘的 handoff.md 逐字节一致；未知 id → 非零退出 |

`tests/task-registry/task-registry.test.ts` 增补：

| # | 断言 |
|---|---|
| C3-T9 | lane 第 2 个 handoff 子进程收到的 prompt 是指针格式（含 handoff id 与 `code-agent handoff body` 指令），长度 <400 字符；lane 首个 handoff 收到全文 |
| C3-T10 | architect（`--no-session`）永远收全文 |

真实 Pi 冒烟（沿 `tests/context/pi-session.test.ts` 既有模式）：

| # | 断言 |
|---|---|
| C3-T11 | 复用 `--session-id` 的第二个 pi 进程，发往 fake provider 的请求 payload 中第一轮的大 tool result 已是指针文本；磁盘 session 文件仍含原文（审计不变） |

验收指标（B4）：重跑 13453/7606，per-round input token 曲线斜率显著
下降；3 个成功 case 全部自然收尾（不再 total_tokens 截断）。

---

## PR C4 — 预算轴分离与 handoff 级软顶（把截断从 run 级灾难降为 handoff 级事件）

### C4.1 `fresh_tokens` 预算轴

**改动**（`benchmark/lib/budgets.ts` + `runner.ts` 计量点）：

- 新轴 `fresh_tokens = input − cache_read + output + reasoning`
  （usage 记录已含全部字段，`runtime/lib/usage.ts:91-103`）；
- `DEFAULT_BENCHMARK_BUDGETS` 加 `fresh_tokens: 800_000`（初值取
  14539 自然收尾 case 的 fresh 用量 ×1.5，pilot 后版本化校准）；
- `total_tokens: 3_000_000` **保留为安全硬顶**；canonical order 变为
  `model_rounds, tool_calls, fresh_tokens, total_tokens, wall_seconds`；
- provider 未报告 cache 字段时（`tokens-cache.test.ts` 已定义的
  absence 语义），`fresh_tokens` 轴**不参与判定**——绝不因数据缺失
  把 fresh 当 0 或当 total。

### C4.2 per-handoff round 软顶

**机制**（`runtime/extensions/usage-ledger/index.ts`——它已按 handoff
归因逐条记 assistant round，且明确区分 failed attempt 不是 round）：

- 环境注入 `CODEFLOW_HANDOFF_ROUND_CAP`，roles.json 每角色可覆盖
  （建议初值：tester 25 / coder 30 / verify 20 / architect 10；0 = off）；
- 子进程内计数达 cap：extension 调 `finishHandoff` 置
  `BLOCKED` + `CONTEXT_BUDGET_EXCEEDED`（枚举已存在于
  `runtime/AGENTS.md` blocked.reason 列表，**不扩枚举**），summary
  固定句式 `handoff round cap <N> reached`，然后 abort 当前 agent；
- 对 planner 这与 `EXECUTION_TIMEOUT` 同构：控制权转移，由它决定
  split / 续开新 handoff（lane session 还在，续开不损失 facts 与磁盘
  证据）；`planning.md` 增补路由："`CONTEXT_BUDGET_EXCEEDED` from a
  lane means the work unit was too large: split the outcome or narrow
  the handoff, never re-issue it unchanged."

### C4.3 planner 收敛规则（防"谨慎复查"回环）

`planning.md` Root closure 段增补："Once a goal's join is satisfied, do
not open further lane handoffs for it; re-verification of an already
satisfied join is waste, not diligence."（14539 自然收尾正因无回环；
13453/7606 的截断均发生在收尾阶段。）

### C4 测试点（锁定）

`tests/benchmark/budgets.test.ts` 增补：

| # | 断言 |
|---|---|
| C4-T1 | `parseBudgetOverrides` 接受 `fresh-tokens=500000` 与 `fresh_tokens=500000`；拒绝 0 与负值（沿既有语义） |
| C4-T2 | `budgetTerminatedBy`：fresh 达标而 total 未达 → 返回 `fresh_tokens`；canonical order 中 `fresh_tokens` 先于 `total_tokens` |
| C4-T3 | cache 字段 absent（非显式 0）时 fresh 轴不触发判定，total 轴照常兜底（对齐 `tokens-cache.test.ts` 的 absence 语义） |

`tests/benchmark/tokens-cache.test.ts` 增补：

| # | 断言 |
|---|---|
| C4-T4 | fresh 累计 = Σ(input − cache_read + output + reasoning)；守恒断言 fresh + cache_read 分量与 total 口径互相校验 |

新文件 `tests/handoff-budget/round-cap.test.ts`：

| # | 断言 |
|---|---|
| C4-T5 | fake session 注入 25 条 assistant usage 后第 26 轮触发：handoff state `blocked`，reason 恰为 `[CONTEXT_BUDGET_EXCEEDED]`，summary 为固定句式 |
| C4-T6 | cap=0 → 永不触发；未设 env → 默认取 roles.json 角色值 |
| C4-T7 | 触发时不产生第二次 terminal transition（对已 finish 的 handoff 幂等，沿 handoff-gate 既有不可变语义） |
| C4-T8 | 失败的 model attempt（usage-ledger 已定义 "never a completed round"）不计入 cap |

`tests/roles/capability-contract.test.ts`（与 C2-T7 同文件）：

| # | 断言 |
|---|---|
| C4-T9 | `planning.md` 含 `CONTEXT_BUDGET_EXCEEDED` 路由句与 join-satisfied 收敛句 |

---

## 落地顺序、对照实验与总验证矩阵

| 顺序 | PR | 前置 | 风险 | 验证手段 |
|---|---|---|---|---|
| 1 | C1 | — | 零（benchmark 层 + prompt） | C1-T1…T8 + 重跑 3 case 看 patch 文件数 |
| 2 | C2 | C1（evidence dir 定义先行） | 低（唯一 runtime 改动有双逃生阀） | C2-T1…T9 + B4 tester 曲线 |
| 3 | C4 | —（与 C2/C3 独立可并行） | 低（软顶 cap=0 可整体关闭） | C4-T1…T9 |
| 4 | C3 | 需确认/补 pi payload transform hook | 中（触碰 payload 组装层） | C3-T1…T11 + pilot A/B |

对照实验设计（Design B 仪表盘承接）：

1. **模板轨迹 A/B**：14539（唯一自然收尾 case）在 C2、C3 各自单独
   开/关下重跑 ×3 attempt，比较 fresh_tokens、tester rounds、是否仍
   自然收尾。任何一项优化使模板轨迹退化（resolved→un、rounds 上升）
   即单独回退——每项都有独立开关：`CODEFLOW_EVIDENCE_DEDUPE`、
   `CODEFLOW_CONTEXT_EVICTION`、round cap=0；
2. **截断 case 复验**：13453 / 7606 在 C2+C3+C4 全开下重跑，验收
   "收尾不再被 total_tokens 截断"；
3. **补评估批次**：6 个非空 not_evaluated patch 在 C1 合入后用新
   `extractPatch` 从留存 workspace 重提取、再送官方 harness（Docker
   限额恢复后）——patch 卫生修复可能直接改变其中依赖 patch 应用
   成功率的判定。

统一验收（仓库既有标准）：`bun test`、`bun run typecheck`、
`git diff --check`、source safety；所有 prompt 改动经
`tests/roles/capability-contract.test.ts` 锁死关键句，防止后续编辑回归。

## 预期指标汇总

| 指标 | 基线（3 成功 case） | 目标 | 归属 |
|---|---|---|---|
| model_patch 文件数 | 7 / 19 / 16 | ≤2 / 1 / 1 | C1 |
| tester rounds | 62 / 43 / 58 | ≤25 | C2 |
| tester tokens 占比 | 55%–85% | ≤40% | C2 |
| total_tokens 截断率 | 15/20 | ≤4/20 | C3+C4 |
| 成功 case 自然收尾 | 1/3 | 3/3 | C3+C4 |
| zipper support rounds | 高频（tester bash 输出触发） | 显著下降（B4 by_role 分解） | C2 |
