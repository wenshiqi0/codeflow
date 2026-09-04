---
name: codeflow
description: Run coding issues and requirements through a Goal-scoped Root that decides its own Worker organization. Also use when the user asks to run, observe, diagnose, resume, or stop a Codeflow Task.
---

# Codeflow

You are the outer observer. Start Tasks from the user's issue or requirement
without complexity labels, time estimates, Worker counts, proposed topology, or
planning envelopes. Root owns organization; Child Workers own the work they
claim. Observe bounded Runtime metadata, never transcripts or hidden reasoning.

The normative collaboration contract is
[`docs/collaboration-semantics.md`](docs/collaboration-semantics.md). In short:

- Task is the Runtime container and root Goal.
- Goal is a reusable one-to-many outcome boundary.
- Commitment is one Worker's self-authored work promise.
- Receipt reports progress, completion, or a blocker.
- All Workers have `inspect`, `claim`, and `report`; Root additionally has
  `delegate`. Child feedback is delivered asynchronously; no Agent blocks on
  another Agent. An idle Root response may end without closing the Task.
- Root remains read-only and delegates substantive repository work to at least
  one Child Worker.

## Commands

```bash
codeflow exec [--manager-model <provider/model>] [--worker-model <provider/model>] "<objective>"
codeflow resume <task-id>
codeflow ls
codeflow sub <task-id> [--since <seq>] [--kind <kind>,...] [--timeout 600]
codeflow goals <task-id>
codeflow usage <task-id>
codeflow audit <task-id> [--force]
codeflow stop <task-id>
```

Use one blocking `sub` call and feed its returned sequence into the next call.
A timeout with no events means only that no new event arrived. Report Task,
Goal, Commitment, Receipt, Runtime failure, and usage metadata; activity alone
is not correctness.

`exec --manager-model <provider>/<model>` overrides only the Manager and
`exec --worker-model <provider>/<model>` overrides only execution Workers.
Neither changes internal service models or repository configuration. `resume` is explicit
and accepts only a fully stopped attempt: `run_finished` or `run_interrupted`,
then `runner_exited`. It re-grounds the original Commitment from durable state
and current external state; it never restores a session.

A `progress` Receipt keeps the Commitment open. `completed` and `blocked` close
it. Runtime failures are events, not Receipts. Never retry a provider, rerun a
benchmark, resume, stop, or otherwise mutate Runtime state without user
authorization.
