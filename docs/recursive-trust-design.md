# Design E v3 — Pull-based 协同索引与递推信任

状态：待评审
基线：`codex/hygiene-context-tester`（Design C 已落地；Design D 正交）
证据基线：astropy__astropy-7166（官方 resolved，115 rounds；tester 40 + coder 40 双双全量重发现）
分支建议：`codex/collaboration-corpus-v3`

## 0. 模型

v2 提出“默认注入 handoff 索引”。v3 改为 **pull-first**：

- 不默认注入 handoff/receipt 语料；
- `goal` 是协同语料的第一层目录；
- worker 在当前 goal 上下文中查询 handoff 不需要传 goal id；
- 跨 goal 查询必须显式传 `--goal-id`；
- 每个 handoff 落地时由 zipper 生成有界语义索引卡；
- 索引卡用于发现和筛选，完整决策信息通过 handoff id 召回；
- handoff body / receipt / terminal state 永远是权威来源，索引卡是可再生派生层。

7166 的重复发现说明协同文档已经存在但被锁在 run 目录里。v3 不新增正式状态机，也不强制流程；它把已有语料变成有界、可发现、可召回的上下文资本。

两公理不变：

- **freedom**：不编排流程、不加分诊、不设置强制阅读顺序；
- **trust**：下游从上游结论出发做增量；发现结论错误时用 superseding fact / 新 receipt 纠错。

## 1. 目录与命令模型

### Goal directory

```text
<run-dir>/
├── goals/
│   ├── <goal-id>/
│   │   ├── contract.json
│   │   └── index/
│   │       ├── <handoff-id>.open.json
│   │       └── <handoff-id>.final.json
│   └── _unlaned/
│       └── index/
└── handoffs/<handoff-id>/
```

`handoffs/` 仍是权威状态。`goals/**/index/` 是可再生派生索引。`_unlaned` 存放 root / architect 等无 goal handoff 的索引卡。

### Commands

```bash
code-agent goal list
code-agent goal show --id <goal-id>

code-agent handoff index
code-agent handoff index --goal-id <goal-id>
code-agent handoff index --unlaned
code-agent handoff index --lane test --status blocked --limit 20

code-agent handoff get --id <handoff-id>
code-agent handoff body --id <handoff-id>
code-agent handoff receipt --id <handoff-id>
```

Scope rules:

- omitted `--goal-id` resolves to ambient `CODEFLOW_GOAL_ID`;
- omitted goal id means “current goal”, never “all goals”;
- cross-goal lookup must pass `--goal-id`;
- exact `handoff get --id` is pointer recall and may cross goal;
- `--unlaned` is the explicit entry for no-goal handoffs.

## 2. Zipper index cards

A card is generated at both landing points:

1. **open card** — handoff body/state become durable;
2. **final card** — terminal state, receipt, and body become durable.

Blocked handoffs also receive final cards; retry clues are collaboration capital.

The runtime first writes a deterministic fallback card, then upgrades it through the dedicated zipper role when enabled. Zipper failure never changes the handoff verdict or blocks the state transition.

### Card shape

```json
{
  "schema_version": 1,
  "kind": "handoff_index_card",
  "phase": "open|final",
  "goal_id": "movement-r1",
  "handoff_id": "h00005-coder",
  "role": "coder",
  "lane": "code",
  "status": "done",
  "result": "PASS",
  "title": "Implement movement fix",
  "digest": "Established the failure in movement bounds and implemented the focused fix.",
  "established": [],
  "decided": [],
  "ruled_out": [],
  "changed_files": [],
  "evidence_refs": [],
  "uncertainties": [],
  "body_ref": "handoffs/h00005-coder/handoff.md",
  "receipt_ref": "handoffs/h00005-coder/receipt.json",
  "source": {
    "body_hash": "sha256:...",
    "receipt_hash": "sha256:..."
  },
  "generator": {
    "kind": "zipper|deterministic",
    "generated_at": "..."
  },
  "fallback": false
}
```

Bounds:

- `digest <= 600` bytes;
- each list `<= 8` entries;
- each list line `<= 180` bytes;
- card JSON output is bounded by the CLI;
- cards never inline artifact bodies or command output.

Cards are regenerable derived metadata. A semantic card is useful for discovery, but an action that depends on detail must retrieve the full handoff.

## 3. Freedom and trust contract

`runtime/AGENTS.md` gains a pull-based contract:

- collaboration history is queryable, not pushed by default;
- query the ambient index when inherited work would reduce redundant discovery;
- retrieve the full handoff when a card is insufficient;
- do not scan run files directly;
- index cards guide discovery; body/receipt/state are authoritative.

No command is mandatory. Runtime provides visibility; the model decides when recall is useful.

## 4. Telemetry

Benchmark telemetry classifies tool operations without storing command arguments:

```text
goal_list
goal_show
handoff_index
handoff_recall
evidence_log
explore
edit
execute
ceremony
other
```

The report adds:

- recall counts by operation kind;
- redundant discovery rate;
- zipper calls / failures;
- index-card fallback count.

This preserves the privacy contract while making it possible to compare explore versus recall.

## 5. Tests

### Scope and query

- ambient goal: omitted goal id queries current goal only;
- cross-goal query requires `--goal-id`;
- exact handoff-id recall may cross goal;
- `goal list` and `goal show` expose bounded goal directories;
- `--unlaned` exposes no-goal handoffs;
- lane/status/limit filters work.

### Cards

- open and final cards are written deterministically before zipper upgrade;
- terminal blocked handoffs receive final cards;
- zipper output validates the bounded schema and source hashes;
- invalid zipper output leaves the fallback card intact;
- semantic generation failure does not alter handoff terminal state;
- cards contain no artifact bodies or command output.

### Recall

- `handoff get` returns state, card, body, and receipt;
- missing receipt degrades to structured `receipt: null`, not a fabricated verdict;
- artifact paths remain refs;
- unknown id exits non-zero with one line.

## 6. Rollout

1. Goal list/show + ambient-scoped handoff index + exact recall.
2. Deterministic open/final cards and zipper upgrade path.
3. Prompt contract and operation taxonomy telemetry.
4. 7166 ×3, 14539 ×3, and one multi-goal case:
   - total rounds;
   - tester+coder rounds;
   - explore versus recall ratio;
   - official verdict;
   - index fallback and zipper failure rates.

Design E v3 deliberately avoids default injection. It turns the existing handoff corpus into a goal-scoped, pull-based, semantically indexed memory without reintroducing a fixed workflow.
