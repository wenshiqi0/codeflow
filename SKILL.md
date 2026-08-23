---
name: codeflow
description: Explicitly invoked Goal-scoped multi-Worker runtime. Use only when the user explicitly asks to run, observe, diagnose, or resume Codeflow.
---

# Codeflow

You are the outer observer. Start or resume Codeflow only after explicit user
authorization. Worker processes own execution and organization; observe them
through bounded runtime metadata, never transcripts or hidden reasoning.

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

`exec` creates a Task and root Handoff. `resume` is explicit and accepts only a
fully stopped attempt: `run_finished` or `run_interrupted`, followed by
`runner_exited`. An interrupted attempt has no Receipt and resumes the original
Handoff from durable semantics and current external state. It never restores a
session or invents a semantic result.

Use one blocking `sub` call and feed its returned sequence into the next call.
A timeout with no events means only that no new event arrived. Report Task,
Goal, Handoff, Receipt, runtime failure, and usage metadata; do not infer
correctness from activity.

Receipt statuses are `completed`, `partial`, `blocked`, `failed`, and
`superseded`. Runtime failures are events, not Receipts. Never mutate runtime
state, retry a provider, rerun a benchmark, or resume a Task without the
corresponding user authorization.
