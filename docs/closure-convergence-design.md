# Design D — 收尾收敛与预算再平衡

状态：待评审
基线：`codex/hygiene-context-tester`（Design C 的 C1–C4 已全部落地）
证据基线：astropy__astropy-7166 单 case run（bench-20260822-055130-2582，
官方 resolved，FAIL_TO_PASS 1/1，PASS_TO_PASS 6/6，patch 2 文件 3,591B）
分支建议：`perf/closure-convergence`，按 D1 / D2 / D3 / D4 / D5 / D6 递进
关系：Design C 的四个机制全部机械生效（patch 卫生、recorder、eviction
hook、round cap、fresh 轴），本设计修的是 7166 数据暴露的**参数与策略
错配**——机制对了，但保护条件、预算权重和收尾路径还没让 run 自然走完。

## 0. 7166 的证据链（每条对应一个 D 项）

| 观测 | 判读 | 归属 |
|---|---|---|
| fresh 263,828 < 300K cap，total 3,018,836 > 3M cap，终止原因 total_tokens；root/verify 收尾被砍 | total 硬顶惩罚"轮次×上下文长度"而非产出；cache read 单价 ~1/10，total 不应再是主约束 | D1 |
| eviction 仅归档 2 文件 ~9KB，而 cache-read 累积 2.75M | `eviction.ts` 对当前 handoff 内条目全豁免；cap 让 handoff 长达 25–30 轮，膨胀源恰在豁免区内 | D2 |
| 三条 lane 首个 handoff 全部触发 round cap；h00007 DELEGATION_ARTIFACT_MISSING | cap 成为常态检查点而非异常；硬 abort 丢掉当前轮 receipt/facts/artifact；角色对 cap 不可见、无法主动收尾 | D3 |
| verify 26 rounds 只产出 3 条 evidence record，且是 20-cap 触发者 | verify 漫游（重读 diff/仓库）而非执行既定命令清单 | D4 |
| fingerprint 每次全量 readFileSync tracked+untracked（astropy ~万级文件） | tracked 未变文件内容已被 HEAD+`diff --binary` 覆盖，全量读冗余 | D5 |
| 本次无 provider payload 捕获，"发出去的确实是指针"仍是间接证据 | 缺 per-request payload 字节数遥测，B4 曲线拿不到直接数据 | D6 |

非目标：

- 不改 handoff 状态机与 blocked reason 封闭枚举；
- 不恢复 compaction；D2 仍是无损确定性外置；
- cap 哲学不变：到顶仍是 BLOCKED + 控制权转移，D3 只是把"到顶"从
  突然死亡变成有预告的收尾窗口。

---

## D1 — 预算再平衡：total 退居纯安全顶（benchmark 层，零运行时风险）

### 改动

1. `benchmark/lib/budgets.ts`：`DEFAULT_BENCHMARK_BUDGETS.total_tokens`
   3_000_000 → **9_000_000**。依据：fresh 轴（300K）现在承担真实产出
   约束；total 只拦截 runaway（死循环重放）。9M ≈ 120 rounds × 75K
   平均上下文，正常长 run 到不了，失控 run 必然撞上；
2. `benchmark/lib/report.ts`：新增异常标记——
   `terminated_by === "total_tokens" && fresh_tokens < 0.5 × fresh cap`
   时 report 记 `anomaly: "cache_replay_dominated"`。这类截断从此在
   报告里显式可见，而不是混在普通预算停里；
3. 预算契约版本化：`docs/benchmark-contract.md` §1.2 更新默认值并注明
   自 Design D 起生效（对照旧 run 时用 `--budget total-tokens=3000000`
   复现旧行为）。

### 测试点（锁定）

`tests/benchmark/budgets.test.ts` 增补：

| # | 断言 |
|---|---|
| D1-T1 | 新默认值 9_000_000；canonical order 不变（fresh 仍先于 total） |
| D1-T2 | `--budget total-tokens=3000000` 覆盖后 `budgetTerminatedBy` 行为与 Design C 基线逐值一致（旧行为可复现） |

`tests/benchmark/report.test.ts` 增补：

| # | 断言 |
|---|---|
| D1-T3 | terminated_by=total_tokens 且 fresh=cap 的 40% → report 含 `cache_replay_dominated`；fresh=cap 的 80% → 不含 |

验收指标：7166 复跑在默认预算下自然收尾（root receipt 写出，
terminated_by=null）。

---

## D2 — eviction 越过 handoff 边界（修正 Design C 的过强保护）

### 改动（`runtime/extensions/codeflow-context/eviction.ts`）

1. **删除 `currentHandoffStartedAt` 的全量豁免**。保护改为纯距离制：
   最近 `EVICT_AFTER_ROUNDS` 个 assistant 轮（注意按**轮**计，不是按
   消息计——现实现 `distance = messages.length - 1 - index` 数的是消息，
   一轮含 assistant + 多条 tool result，8 条消息 ≈ 3 轮，保护窗比设计
   预期窄；改为向前扫描 assistant 消息计轮次）之外的大 tool result
   一律可 evict，**无论是否属于当前 handoff**；
2. 保留既有保护：`code-agent handoff` / `code-agent evidence` CLI 输出
   永不 evict；归档写失败不 evict；指针文本 byte-stable、单调；
3. `EVICT_MIN_BYTES` 4KB 不变（7166 的两个归档 4.3/4.5KB 证明阈值
   本身合理，问题只在豁免区）。

### 语义论证

当前 handoff 内的旧 tool result 与上个 handoff 的旧 tool result，对
"角色此刻决策所需"没有本质区别——距离 8 轮以上的原文若真被需要，
`code-agent evidence log` 一次取回即可，成本远低于每轮重放。cap 长度
（25–30 轮）的 handoff 里，第 9 轮之后每轮都在为第 1–8 轮的 pytest
输出付 cache read；这正是 7166 中 2.75M cache-read 的主体。

### 测试点（锁定）

`tests/context/eviction.test.ts` 修订 + 增补：

| # | 断言 |
|---|---|
| D2-T1 | 同一 handoff 内：第 1 轮的 >4KB tool result 在第 10 轮组装时被 evict（旧 C3 语义反转，显式锁定新行为） |
| D2-T2 | 轮次计数按 assistant 消息数：8 条 assistant 之内的 tool result 全保留，恰第 9 轮前的可 evict（边界±1 各一断言） |
| D2-T3 | CLI 输出保护、单调性（C3-T4）、写失败不 evict（C3-T6）在新策略下回归绿 |
| D2-T4 | `currentHandoffStartedAt` 参数删除后类型不再暴露；调用点（codeflow-context/index.ts）不再读 state.json 的时间戳（该 IO 整体移除） |

验收指标（B4）：7166 复跑 per-round cache_read 曲线在第 ~9 轮后
显著转平；tool-log 归档数从 2 → 与 >4KB tool result 数量同数量级。

---

## D3 — cap 预告与收尾窗口：从硬 abort 到 graceful finish

### 改动（`runtime/extensions/usage-ledger/index.ts`）

1. **cap 预告**：rounds 达到 `cap − GRACE`（GRACE 默认 3，
   `CODEFLOW_HANDOFF_ROUND_GRACE` 可调）时，向 session 注入一条
   `display: true` 的 custom message（与 codeflow-context 同通道，
   保持可见性契约），文本固定 byte-stable：
   `[round budget: <used>/<cap> rounds used in this handoff; finish now — write your receipt and call code-agent handoff finish within <grace> rounds]`
   只注入一次；
2. **cap 行为不变**：到 cap 仍 `finishHandoff BLOCKED
   CONTEXT_BUDGET_EXCEEDED` + abort——预告给了角色 3 轮收尾窗口，
   用不用是它的事，fail-closed 底线不动；
3. 角色若在窗口内正常 finish（PASS/FAIL + receipt + facts），则
   继续 handoff 从 receipt/facts/checkpoint 起步，而不是从零重发现
   ——这消除 7166 中 3 次 cap 触发各自丢失的当轮状态；
4. `runtime/AGENTS.md` 增补一句 shared 契约："A round-budget warning
   in your context is a hard signal: stop opening new work, record your
   receipt facts, and finish."

### 测试点（锁定）

`tests/handoff-budget/round-cap.test.ts` 增补：

| # | 断言 |
|---|---|
| D3-T1 | rounds = cap−3 时注入 warning entry 恰一次；cap−4 时不注入；文本与固定句式逐字节一致 |
| D3-T2 | 角色在窗口内 finish（receipt 落盘）→ 到 cap 时不再发 BLOCKED（handoff 已 terminal，幂等保护即 C4-T7 语义复用） |
| D3-T3 | 角色未 finish → 到 cap 行为与现状逐字节一致（BLOCKED + 固定 summary + abort） |
| D3-T4 | GRACE=0 → 无预告直接 cap（旧行为可复现）；GRACE ≥ cap → 拒绝（配置错误 fail loud） |

`tests/roles/capability-contract.test.ts` 增补：

| # | 断言 |
|---|---|
| D3-T5 | `runtime/AGENTS.md` 含 round-budget warning 契约句 |

验收指标：复跑中 cap 触发的 handoff，其后继 handoff 的前 5 轮不再
出现重复发现动作（B4 rounds 分布）；`DELEGATION_ARTIFACT_MISSING`
不再与 cap 同时出现。

---

## D4 — verify 轮次收敛（prompt 层）

### 改动

1. `references/capabilities/verification.md` 增补硬规则：
   - "Execute the commands named by the handoff, classify each, and
     finish. Do not re-derive the test plan, re-explore the repository,
     or re-read files the diff does not touch. Target: one recorder
     call per named command plus at most three orientation rounds."
   - diff 检查限定为 `git diff` 输出本身 + 变更文件，禁止仓库级漫游；
2. `references/capabilities/planning.md` 委派规则增补：verify handoff
   必须**列出命令清单**（FAIL_TO_PASS 复现命令 + 至多一次全量回归），
   不许发"verify the fix"式开放委托；
3. `runtime/roles.json`：verify `handoff_round_cap` 20 → **12**
   （3 条命令 + 分类 + finish 的合理上界；D3 的预告让 12 不再危险）。

### 测试点（锁定）

`tests/roles/capability-contract.test.ts` 增补：

| # | 断言 |
|---|---|
| D4-T1 | `verification.md` 含 "Do not re-derive the test plan" 关键句与 one-recorder-call-per-command 句 |
| D4-T2 | `planning.md` 含 verify 命令清单委派句 |
| D4-T3 | roles.json verify cap = 12（roles.test.ts 同步更新） |

验收指标：verify aggregate rounds 26 → ≤12；verify 不再是 cap 触发者。

---

## D5 — fingerprint 成本修剪（`runtime/lib/command-evidence.ts`）

### 改动

`commandEvidenceFingerprint` 的输入从
`HEAD + status + tracked diff + 全部 tracked+untracked 文件内容`
收缩为：

```
HEAD + status(--untracked-files=all) + git diff --binary HEAD + 仅 untracked 文件内容
```

论证：tracked 文件的任何字节变化必然出现在 `diff --binary HEAD` 里
（含 mode/rename），未变 tracked 文件由 HEAD 唯一决定——全量读内容是
纯冗余。untracked 文件不被 diff 覆盖，保留内容读取。astropy 量级仓库
的每次 evidence run 从 ~万次 readFileSync 降到通常个位数。

灵敏度语义不变：这是 D5 测试的全部意义——修剪只许去冗余，不许丢灵敏度。

### 测试点（锁定）

`tests/evidence/command-evidence.test.ts` 增补（灵敏度锁）：

| # | 断言 |
|---|---|
| D5-T1 | tracked 文件字节变化（内容改、mode 改、rename）→ fingerprint 变 |
| D5-T2 | untracked 文件字节变化（status 行不变的情况：同名文件改内容）→ fingerprint 变 |
| D5-T3 | 无任何变化连续两次 → fingerprint 相同（dedupe 前提） |
| D5-T4 | 大量 tracked 未变文件的仓库：fingerprint 不打开这些文件（以注入 fs 计数 seam 或 fixture 目录只读权限证明——tracked 未变文件设为不可读仍能算出 fingerprint） |
| D5-T5 | C2-T1…T6 全部回归绿（dedupe 行为不变） |

---

## D6 — payload 遥测：补上"发出去的确实是指针"的直接证据

### 改动（`runtime/extensions/telemetry-ledger/index.ts`，benchmark 门控不变）

每次 provider 请求记录一行：
`{ turn, handoff_id, payload_bytes, evicted_entries, evicted_bytes }`
——`evicted_*` 由 eviction pass 返回值透出（`evictToolResults` 返回
`{ messages, evictedCount, evictedBytes }`，非 benchmark 模式下该
统计仍计算但不落盘）。B4 的 per-round context 曲线从此有直接数据，
C3-T11 那类"payload 里确实是指针"的验证也有了 run 级证据。

### 测试点（锁定）

| # | 断言 |
|---|---|
| D6-T1 | `evictToolResults` 返回值新增统计字段；无 evict 时 count=0、bytes=0；messages 引用语义不变（既有测试回归绿） |
| D6-T2 | fake session 下 telemetry 行含 payload_bytes 且 evicted_bytes 与归档文件字节和一致 |
| D6-T3 | 非 benchmark 模式（无 `CODEFLOW_BENCHMARK_DRIVER_LEDGER_DIR`）不写任何遥测文件（extension 门控回归） |

---

## 落地顺序与对照实验

| 顺序 | PR | 前置 | 风险 | 验证 |
|---|---|---|---|---|
| 1 | D1 | — | 零 | D1-T1…T3 |
| 2 | D5 | — | 零（灵敏度锁保底） | D5-T1…T5 |
| 3 | D2 + D6 | —（同触 eviction，合并落地） | 低（`CODEFLOW_CONTEXT_EVICTION=off` 仍可整体关闭） | D2-T1…T4 + D6-T1…T3 |
| 4 | D3 | — | 低（GRACE=0 复现旧行为） | D3-T1…T5 |
| 5 | D4 | D3（12-cap 依赖预告机制） | 低（prompt + 一个数字） | D4-T1…T3 |

对照实验：

1. **7166 复跑 ×3**（全开）：验收自然收尾（terminated_by=null、root
   receipt 写出、`DELEGATION_ARTIFACT_MISSING`=0）、cache_read 曲线
   第 ~9 轮转平、verify ≤12 rounds、官方仍 resolved；
2. **14539 模板轨迹 ×3**：确认 D2/D3 不使唯一自然收尾 case 退化；
3. **剩余 5 个 not_evaluated + 13453/7606** 批量复跑：验收
   total_tokens 截断率与 handoff BLOCKED 分布整体改善。

统一验收不变：`bun test`、`bun run typecheck`、`git diff --check`、
source safety、capability-contract 关键句锁。

## 预期指标（以 7166 为基线）

| 指标 | 7166 基线 | 目标 | 归属 |
|---|---|---|---|
| 终止原因 | total_tokens 截断 | 自然收尾 | D1+D2 |
| cache read | 2,755,008 | <1.5M（曲线第 ~9 轮转平） | D2 |
| tool-log 归档数 | 2 | 与 >4KB tool result 同数量级 | D2 |
| cap 触发次数 | 3/3 lane | ≤1（且触发前有预告、有 receipt） | D3+D4 |
| DELEGATION_ARTIFACT_MISSING | 2 | 0 | D1+D3 |
| verify rounds | 26 | ≤12 | D4 |
| evidence run 文件读取量 | ~全仓库 | 仅 untracked | D5 |
