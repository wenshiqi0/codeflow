# Design F — Depth-Scoped Equal Workers

状态：待评审
基线：`codex/collaboration-corpus-v3`（Design C + Design E v3 已实现）
证据基线：astropy__astropy-7166 有效 run
（`bench-20260822-194904-0efc`，官方 resolved、自然收尾、112 rounds）
分支建议：`codex/depth-scoped-equal-workers`

## 0. 结论

Codeflow 不应该用“人员编制”建模。

当前 `planner / tester / coder / verify / architect` 的角色配置把四种不同的
概念耦合在一起：

```text
组织能力
工作方法
模型选择
机械安全边界
```

Design F 将它们拆开：

```text
organization capability -> depth
work methods            -> worker knowledge
model                   -> global worker default
safety                  -> exact runtime/run-state boundary
```

没有 coordinator 身份。`depth === 0` 的 worker 获得组织工具；它可以组织
其他 worker，也可以选择单人直接完成。组织工具是能力，不是流程，也不是
职位。

## 1. 证据

7166 暴露了三类问题。

### 1.1 角色流程造成动作放大

有效 run 的角色轮次：

```text
planner  20
tester   39
coder    20
verify   33
```

该任务本身很小：issue 已经指出 `inspect.isfunction` 对 property 为 false，
最终产品修复只有一行条件扩展。

固定 `tester -> coder -> verify` 仪式使一个简单任务天然变成多个 handoff。
对于该任务，一个 depth-0 worker 直接定位、写 focused regression、修复并
验证，可能是同等或更小的动作。

### 1.2 工具权限误伤目标工作区

Pi session 中反复出现：

```text
Codeflow runtime is read-only during a run
```

影响：

```text
tester edit 测试文件
coder edit 产品文件
verify write 临时验证脚本
planner write root receipt / closure artifact
```

随后 worker 通过 Bash + Python/heredoc 绕过。结果是：

1. 目标工作本来可以直接使用审计过的 write/edit 工具；
2. guard 变成过度拦截；
3. Bash 绕过削弱工具级审计；
4. root closure 多花多轮推断 evidence 目录。

根因是 host guard 把 runtime 父目录和嵌套的 benchmark workspace 都视作
host runtime，而不是精确保护 runtime 与 run metadata。

### 1.3 测试优先被写成了流程

之前的 tester prompt 把“写测试”和“只写测试”提升为角色职责：

```text
tester 只写测试
coder 才实现
verify 才执行
```

这推翻了更基本的原则：

```text
TDD、diagnosis-first、characterization、direct implementation
都是 worker 的方法选择，不是角色身份。
```

一个 worker 可以单人走 TDD，也可以直接诊断并修复；除非任务本身要求交付
测试，系统不应指定方法。

## 2. Runtime model

### 2.1 Depth-scoped organization

```text
worker
├── depth 0
│   ├── 拥有 goal / task / task_group
│   └── 可 solo，也可组织其他 worker
└── depth > 0
    └── 只处理当前 handoff
```

规则：

```text
organization tools are gated by depth, not by role
```

Depth 0 不是 coordinator。它只是当前具有组织能力的 worker。它可以完全不使用
组织工具，直接完成工作并机械 finish root handoff。

Depth > 0 不注册组织工具，避免递归失控、预算归属断裂和任务树爆炸。若工作
过大，它向 depth 0 返回 split request；是否继续拆分由 depth 0 决定。

### 2.2 Equal workers

所有 worker 具有相同基础能力：

```text
read
write
edit
bash
code-agent CLI
collaboration index recall
```

不按 role 配置 tools，不按 role 禁止 edit/write/bash。

Handoff 可以声明交付物、边界和验收证据，但不通过剥夺基础工具来规定流程。
独立验证通过 fresh context 与任务契约实现，而不是把某个 worker 降级成
只读角色。

### 2.3 Model policy

当前阶段：

```text
all workers, including depth 0 -> zhipuai-coding-plan/glm-5.3
zipper -> zipper 自身固定模型
```

Depth 0 不选择模型，handoff 不携带模型，roles registry 不做业务角色到模型
的映射。zipper 是程序保障的内部压缩层，不是业务 worker。

模型选择、路由和成本优化后续单独设计，不混入 Design F。

## 3. Prompt model

### 3.1 Depth-0 organization description

Depth 0 得到一段中性描述，说明常见软件协同组织形式。它不鼓励、不推荐、
不排序、不设置默认路径，也不使用“应该”“最好”“优先”等偏好词。

建议内容：

```md
## Organization

This process is at depth 0. The `goal`, `task`, and `task_group` tools are
available at this depth. Their use is optional.

Forms of software work include:

- direct completion by the depth-0 worker;
- separated specification, implementation, and evaluation;
- parallel ownership of disjoint modules or invariants;
- implementation followed by review;
- investigation before change.

A handoff states its outcome, relevant context, boundaries, and evidence.
Other forms exist.
```

这段是事实描述，不是管理指令。单人直接完成与多人拆分是并列形式。

### 3.2 Worker method description

工作方法属于所有 worker，不属于 tester/coder/verify。

建议 worker prompt 中的方法目录保持同样中性：

```md
## Work methods

Methods for software work include:

- direct implementation;
- diagnosis-first work;
- test-driven development;
- characterization before change;
- scratch reproduction;
- benchmark-driven optimization;
- investigation without change;
- implementation followed by self-review.

A worker may use, combine, adapt, or omit these methods according to the task.
Unless the handoff states a required deliverable or evidence form, none is
mandatory.
```

TDD 等单人工作模式保留为 worker 的能力选择。它们与 depth 0 的组织能力是
正交概念：

```text
depth 0 + solo + TDD
depth 0 + delegation
depth > 0 + TDD
depth > 0 + diagnosis-first
```

### 3.3 Capability references

现有 `testing.md / implementation.md / verification.md` 不再作为角色身份
prompt。可迁移为工作方法参考：

```text
references/work-methods/test-driven.md
references/work-methods/diagnosis-first.md
references/work-methods/characterization.md
references/work-methods/reproduction.md
references/work-methods/benchmark.md
references/work-methods/review.md
```

每个参考文档只描述：

```text
方法是什么
通常包含哪些步骤
哪些证据形态常见
```

不描述：

```text
你是 tester/coder/verifier
必须采用该方法
推荐该方法
该方法优于其他方法
```

## 4. Handoff contract

Handoff 描述结果与证据，不描述流程。

推荐形态：

```md
Outcome:
Make InheritDocstrings propagate docstrings for property overrides.

Known context:
The issue says the current metaclass uses inspect.isfunction, which is false
for properties.

Boundaries:
The final benchmark diff must remain inside the target repository workspace.

Evidence:
Convince the next reader that property behavior changed and existing function
behavior did not regress.
```

不推荐：

```md
先写测试
只许改测试
再交给 coder
必须跑单个 test node id
必须由 verify 跑全量回归
```

只有当任务本身要求某个交付物时，例如“交付一个 regression test”或“提供
fresh-process verification”，该交付物才是 handoff 要求；这不是系统预设
流程。

## 5. Safety model

### 5.1 保留机械边界

以下仍是平台硬规则：

```text
不能修改 Codeflow runtime source
不能直接写 handoff/state/receipt
不能污染 run metadata
不能读取或输出 secrets
benchmark 中不能访问外部答案、gold patch 或 evaluator-only data
状态转移必须通过 code-agent
handoff 必须 mechanical finish
```

这些规则不限制工作方法，只保证系统可审计、可复现、安全。

### 5.2 Host guard 精确化

保护：

```text
runtime source
handoffs/
goals/
events/
pi-sessions/
usage ledgers
state.json
receipt.json
secrets
host config
```

允许：

```text
CODEFLOW_PROJECT_DIR
CODEFLOW_EVIDENCE_DIR
benchmark attempt workspace
```

必须使用 canonical path 判断，不能把 runtime 父目录或整个 `.codeflow`
树一刀切为只读。目标 workspace 嵌套在 run 输出目录下时，仍应允许
write/edit。

Root worker 与 delegated worker 都应获得：

```text
CODEFLOW_PROJECT_DIR=<target workspace>
CODEFLOW_EVIDENCE_DIR=<absolute evidence dir>
```

## 6. Registry migration

目标 registry 只保留：

```text
worker
zipper
```

`worker`：

```text
model = zhipuai-coding-plan/glm-5.3
prompt = universal worker
tools = universal worker tools
```

`zipper`：

```text
internal = true
固定内部模型
不参与业务 handoff
```

不再为业务任务配置：

```text
planner
tester
coder
verify
architect
```

兼容阶段可保留旧 role label 作为 telemetry label，但不再让 label 决定
tools、model、prompt、goal lane 或 authority。

## 7. Implementation slices

### F1 — 精确 host guard

1. canonicalize path；
2. 保护 exact runtime 与 run metadata；
3. allow `CODEFLOW_PROJECT_DIR` / `CODEFLOW_EVIDENCE_DIR`；
4. 给 root worker 注入上述环境变量；
5. 保持 secrets/runtime/run-state 硬边界。

验收：worker 在 benchmark workspace 中可直接 write/edit；直接修改 runtime
与 run metadata 仍被拒绝。

### F2 — depth-gated organization tools

1. `goal/task/task_group` 注册条件改为 `depth === 0`；
2. 删除 `roles.json` 的 `delegates` 权限来源；
3. depth 0 可选择不使用组织工具并直接 finish；
4. depth > 0 的 split request 返回 depth 0。

验收：没有 coordinator role；solo root path 无 goal/task 也能合法 PASS。

### F3 — universal worker prompt

1. 引入 universal worker prompt；
2. depth 0 附加中性 organization description；
3. 所有 worker 可见中性 work-method catalog；
4. 替换 tester/coder/verify 身份 prompt。

验收：prompt 不含强制测试优先、角色分工、推荐或偏好词。

### F4 — work-method references

1. 将 testing/implementation/verification capability prompt 改造为
   work-method references；
2. 内容只描述方法与证据形态；
3. worker 可按任务自行选择。

### F5 — registry simplification

1. 业务 role 配置退役；
2. worker/zipper 保留；
3. 所有 worker 使用 GLM 5.3；
4. zipper 保持内部固定模型。

## 8. Tests

### Depth and organization

| # | 断言 |
|---|---|
| F-T1 | depth 0 注册 goal/task/task_group；depth 1 不注册 |
| F-T2 | role label 不影响组织工具注册 |
| F-T3 | depth 0 不调用组织工具、直接修改并 finish root 是合法路径 |
| F-T4 | depth 1 无组织工具 |

### Equal capability

| # | 断言 |
|---|---|
| F-T5 | worker registry 无业务 role 工具差异 |
| F-T6 | 所有 worker 使用 GLM 5.3 |
| F-T7 | zipper 是 internal 且不进入业务 handoff |
| F-T8 | handoff 不携带 model 选择 |

### Prompt neutrality

| # | 断言 |
|---|---|
| F-T9 | depth-0 organization prompt 不含 should/prefer/encourage/recommended |
| F-T10 | work-method prompt 不含 should/prefer/encourage/recommended |
| F-T11 | TDD、direct implementation、diagnosis-first 是并列方法 |
| F-T12 | prompt 不声明 tester/coder/verify 身份职责 |

### Host guard

| # | 断言 |
|---|---|
| F-T13 | `CODEFLOW_PROJECT_DIR` 下 write/edit 允许 |
| F-T14 | `CODEFLOW_EVIDENCE_DIR` 下 write/edit 允许 |
| F-T15 | runtime source 写入拒绝 |
| F-T16 | handoff/state/receipt 直接写入拒绝 |
| F-T17 | nested benchmark workspace 不因位于 `.codeflow` 下而被误拒 |

### Solo path

| # | 断言 |
|---|---:
| F-T18 | depth 0 可直接完成一个测试任务，不创建 goal/task |
| F-T19 | root PASS 不因没有 goal而被拒绝 |
| F-T20 | solo TDD 与 solo direct fix 都可用 |

## 9. 对照实验

1. `7166 ×3`
   - baseline：Design E v3 多角色；
   - F：depth-scoped equal worker；
   - 比较 rounds、handoff count、official verdict、natural closure、patch size。

2. `14539 ×3`
   - 验证原本自然收尾的模板轨迹不退化。

3. 一个多模块复杂 case
   - 验证 depth 0 在真正需要拆分时仍会使用组织工具。

统一验收：

```text
bun test
bun run typecheck
git diff --check
source safety
```

## 10. Design principles

```text
1. 没有 coordinator 身份；
2. 组织能力由 depth 决定；
3. 单人工作是并列形式，不是退化形式；
4. 所有 worker 平权；
5. 工作方法属于 worker，不属于角色；
6. prompt 只描述事实，不鼓励、不推荐、不预设流程；
7. handoff 描述 outcome/context/boundary/evidence；
8. 所有业务 worker 使用 GLM 5.3；
9. zipper 是内部程序保障层；
10. host guard 精确保护 runtime 与 run state，不保护目标工作区；
11. 模型路由后续单独设计。
```
