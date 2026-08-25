---
name: codeflow
description: Goal-scoped multi-Worker runtime. Use when the caller supplies a time-and-coding-complexity admission decision to start Codeflow, or when the user asks to observe, diagnose, resume, or stop an existing Codeflow Task.
---

# Codeflow

You are the outer observer. Worker processes own execution and organization;
observe them through bounded runtime metadata, never transcripts or hidden
reasoning.

## Admission input

Before `exec`, the caller supplies this out-of-band input to the skill; it is
not a CLI flag or part of the Task objective:

```yaml
admission:
  multi_agent: true | false
  source: explicit_user | outer_assessment
  time:
    solo_estimate: <duration or range>
    parallelizable: true | false
    rationale: <brief evidence>
  coding_complexity:
    level: low | medium | high
    rationale: <brief evidence>
```

For `outer_assessment`, set `multi_agent: true` only when the expected solo
critical path is substantial and parallel work can shorten it, or when the
coding work spans enough independent modules, interfaces, invariants, unknowns,
or verification surfaces that one context is unlikely to close it reliably.
Long but inherently serial waits and many repetitive edits do not qualify by
themselves. This is an admission decision, not a score or a prescribed
workflow.

If the user explicitly requests Codeflow, set `source: explicit_user` and
honor that choice. Otherwise, absent or false admission means do not run
`exec`; continue directly outside Codeflow without asking the user to fill in
the metadata. Admission selects a multi-Worker-capable Runtime only. It does
not predetermine roles, phases, Goal count, Handoffs, or whether the root Worker
eventually records `decomposition: split` or `decomposition: solo`.

## Commands

```bash
codeflow exec "<objective>"
codeflow resume <task-id>
codeflow ls
codeflow sub <task-id> [--since <seq>] [--kind <kind>,...] [--timeout 600]
codeflow goals <task-id>
codeflow usage <task-id>
codeflow audit <task-id> [--force]
codeflow stop <task-id>
```

`Task` is the Goal Graph root, so root work uses `goal_id = task_id`. Child
Goals exist only when the work is genuinely split. All agents are equal
Workers; the root Worker receives organization tools from the Runtime rather
than a privileged identity or prompt declaration.

The root Worker may use the atomic `handoff_spawn` organization tool or the
lower-level Goal/Handoff/Worker tools. Every root Receipt records a split/solo
decomposition decision. Delivery-obligation declarations and decomposition
are classified by offline observation; they do not change Receipt status.

`exec` creates a Task and root Handoff. `resume` is explicit and accepts only a
fully stopped attempt: `run_finished` or `run_interrupted`, followed by
`runner_exited`. An interrupted attempt has no terminal Receipt and resumes the
original Handoff from durable semantics and current external state. It never
restores a session or invents a semantic result.

Use one blocking `sub` call and feed its returned sequence into the next call.
A timeout with no events means only that no new event arrived. Report Task,
Goal, Handoff, Receipt, runtime failure, and usage metadata; do not infer
correctness from activity.

One Handoff may carry an append-only chain of Receipts. A `progress` Receipt
advances durable semantics without closing it; only a terminal Receipt
(`completed`, `partial`, `blocked`, `failed`, `superseded`) closes the Handoff
and finishes the run. A process ending after durable progress is reported as a
missing terminal Receipt, not as missing work. Runtime failures are events, not
Receipts. Never mutate runtime
state, retry a provider, rerun a benchmark, resume, or stop a Task without the
corresponding user authorization.

Recall is pull-first. Goal `state` returns reduced state; Goal `semantic`
returns the latest relevant Handoff with its folded Receipt state and head;
only `full` returns complete Handoff and incremental Receipt history. A
Handoff may be recalled at the same levels, and an exact Receipt is addressed
by its content id.
