---
name: codeflow
description: Run coding issues and requirements through Goal-scoped Agents that organize and execute work recursively. Also use when the user asks to run, observe, diagnose, resume, or stop a Codeflow Task.
---

# Codeflow

You are the outer observer. Start Tasks from the user's issue or requirement
without complexity labels, time estimates, Agent counts, proposed topology, or
planning envelopes. Root owns the overall outcome; every Agent owns its claimed
work and may delegate independent work. Observe bounded Runtime metadata, never
transcripts or hidden reasoning.

The normative collaboration contract is
[`docs/collaboration-semantics.md`](docs/collaboration-semantics.md). In short:

- Task is the Runtime container and root Goal.
- Goal is a reusable one-to-many outcome boundary.
- Commitment is one Agent's self-authored work promise.
- Receipt reports progress, completion, or a blocker.
- All Agents have `inspect`, `claim`, `report`, `delegate`, and engineering
  tools. Claim precedes effects and delegation. Root and Child differ only in
  topology; delegation can recur at any depth under the shared Task concurrency
  cap. There is no minimum Child count.
- Child feedback is delivered asynchronously to each Parent; no Agent blocks
  on another Agent. An idle response may end without closing its Commitment.
  Parents reconcile descendants before terminal reporting; Root reports the
  overall Task outcome.

## Commands

```bash
codeflow exec [--model <provider/model>] "<objective>"
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

`exec --model <provider>/<model>` selects the same model for all Agents without
changing internal service models or repository configuration. `resume` is explicit
and accepts only a fully stopped attempt: `run_finished` or `run_interrupted`,
then `runner_exited`. It re-grounds the original Commitment from durable state
and current external state; it never restores a session.

A `progress` Receipt keeps the Commitment open. `completed` and `blocked` close
it. Runtime failures are events, not Receipts. Never retry a provider, rerun a
benchmark, resume, stop, or otherwise mutate Runtime state without user
authorization.
