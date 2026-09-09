---
name: codeflow
description: Use codeteam to organize coding work with Pi Agents, inspect results, follow up, resume, or stop a Codeflow Task.
---

# Codeflow

You are the outer loop and own organization and the overall result.
When the outer model needs a subagent, it can delegate bounded work to a Pi Worker with `codeteam spawn`, or reuse an idle Worker with `codeteam followup`, instead of creating a native host subagent.
Pi has engineering tools, `collaborate inspect/claim/report`, and access to the
same `codeteam` CLI. This version does not prohibit Pi from creating Agents;
do not treat an assignment as proof that it will remain a leaf. Coordinate from
actual Task state without introducing a separate Manager role.

Read [`docs/collaboration-semantics.md`](docs/collaboration-semantics.md) before
running or changing the protocol. For SWE-bench preparation and official
evaluation, also read [`docs/benchmark-contract.md`](docs/benchmark-contract.md).

## Organize from actual work

Start from the user's outcome and inspect enough code to identify a useful
initial boundary. Create a Task, then assign bounded work. Do not solve an
independent question locally before assigning it for duplicate discovery.
Keep useful work moving yourself while Agents execute asynchronously.

Reassess organization when Claims, progress Receipts, results, or repository
evidence expose new questions. Independent boundaries may be different files,
consumers, explanations, counterexamples, or verification approaches. Spawn
when independence improves speed or confidence; a clear small issue can use
one Agent. Do not impose fixed developer/tester roles, depths, or headcounts.
Separate concurrent write boundaries and do not duplicate an active assignment.

Choose reuse deliberately:

- `spawn`: a fresh Agent with fresh context, useful for independent work,
  independent evaluation, a different Goal, or an unsuitable old context.
- `followup`: an **idle** Agent continues its own Pi session in the same Goal.
  Prefer it when its investigation or implementation context helps with a
  related correction or next question. It is not an independent reviewer of
  its own prior conclusions. New execution id, same Agent id.
- `resume`: explicitly restart an **interrupted and fully stopped** Agent with
  fresh context, preserving any original open Commitment. Re-inspect effects
  before retrying work. This is recovery, not conversation reuse.

Goal reuse and Agent reuse are different. Keep the Goal while the desired
outcome is unchanged; create a Goal only for a materially different result or
dependency boundary. Several Agents can work under one Goal.

A focus supplies the question/deliverable, relevant paths or evidence ids,
known constraints, and shared-write boundaries. Keep it concise and coherent;
do not prewrite the Agent's Commitment or assert an unverified solution.
Show the initial Goal and the exact focus you send in the current conversation,
once per assignment. For a followup, show the new focus and refer to the unchanged
Goal. The control response echoes these caller-authored instructions; they are
not the full rendered Pi prompt, which also includes its Agent contract and context.
New Agents do not inherit your conversation. Reused Agents retain their own
history, but still need the new assignment and any changed external facts.

## Control and observe

Run from the target repository root. The installed `runtime/bin` must be on
PATH; otherwise use its absolute `codeteam` path. Control results are JSON.

```bash
codeteam start [--model provider/model] '<user outcome>'
codeteam goal <task> <goal-id> '<distinct outcome>' [--depends a,b]
codeteam spawn <task> [--goal id] '<bounded focus>'
codeteam status <task>
codeteam watch <task> [--since <seq>] [--idle 300]
codeteam inspect <task> [--goal id|--commitment id|--receipt id]
codeteam followup <task> <agent-id> '<related next assignment>'
codeteam resume <task> <agent-id> '<recovery focus>'
codeteam usage <task>
codeteam stop <task> [agent-id]
codeteam finish <task> --status completed --summary '<evidence-backed result>'
codeteam finish <task> --status blocked --summary '<blocker>' --remaining '<work>'
```

`start` creates metadata, not a model Manager. Assignments return immediately.
Busy Agents and full capacity reject new assignments without queueing or
waiting for model work. Start one asynchronous `watch` per active Task and keep
its process/session handle across followups. It streams assignments, Claims,
progress Receipts, context pressure, status changes, and attention notices as NDJSON. Usage-only
increments silently extend that execution's inactivity window; unchanged
snapshots produce no output. Read the same stream, rather than running a new
`sub` after each fixed timeout. `sub` remains a bounded historical/diagnostic read.

`--idle` is an observation window, not a Worker time limit. A quiet execution
produces one attention notice, not a declaration of death or an automatic retry.
The stream stays open while the Task is open, including idle periods awaiting
followup. Task finish closes it; cancelling the observer does not stop Workers.
Usage arrives after a model response, so a pending request or long tool can be
alive without new usage. A busy peer's usage never proves this Worker is active.

`context_pressure` events report Pi's context estimate at the 50%, 70%, and 80%
thresholds, once per rising level in each execution. Read their Agent/execution
identity and numeric measurements alongside progress Receipts to plan remaining
work and session reuse. They are durable events, available after reconnecting
with `--since`; they do not change work state. The 80% event precedes the existing
context-budget interruption, whose stopped execution must be reconciled before
recovery. Missing estimates produce no pressure signal.

Use the host's asynchronous transport to consume the persistent stream. Handle
transport-level empty waits programmatically with the same handle; they are not
new Task events and need no narration. A CLI stream alone cannot inject a message
into an already-ended host turn; do not claim background wakeup without host
support. Continue useful work and surface meaningful progress or required action.
When a host's shell transport keeps yielding empty timed reads, read
[`references/observation.md`](references/observation.md) for the persistent
host-side consumption pattern instead of restarting subscriptions.

Read Claims early when their boundaries affect your decisions. If an Agent
prematurely narrows the question, expand evidence coverage yourself or assign
an independent check; do not rewrite its immutable Commitment. Running Agents
are not steerable in this version. A followup requires idle; if changing live
work requires cancellation, use explicit authorized stop and recovery.

Observe work through bounded events, Commitments, Receipts, files/diffs, and
verification evidence. Do not read Pi sessions or hidden reasoning to decide
organization. A session is private execution context, never the result record.
Give concise progress updates when findings, implementation, verification, or
blockers change; do not repeat usage on every update. Use usage internally as
activity evidence and report it on request or in a concise final accounting,
labeled per Task: calls, input, output, cache-read, reasoning, total. Reasoning
is a subset of output, not an extra addition. Unavailable outer-model usage
is unavailable, not zero.

## Close the actual outcome

Agents self-author Commitments after grounded inspection. Claim records work
responsibility, not tool permission; Runtime does not gate engineering tools on
Claim status. `progress` keeps one open; `completed` or `blocked` closes it.
`completed` means the Agent has finished its contribution and may include
remaining work. Read the summary, effects, verification limits, and remaining
work to decide what to assign next. Reuse the Goal for a continuation; choose
an idle Agent's session only when its context and available space are useful,
or spawn a fresh Agent from the durable reports.
A crashed process, provider error, missing Receipt, or 80% context interruption
is not a semantic blocker or success. Inspect Runtime failures and existing
effects before deciding on an explicitly authorized recovery. Do not silently
retry external model calls.

An Agent's terminal Receipt does not close the outer Task. Inspect results,
verify the integrated diff against the user's outcome, and resolve or disclose
remaining work. `finish` requires all execution processes stopped and every
Commitment terminal; it records your Task conclusion without fabricating an
Agent Receipt. Your Task conclusion is based on the combined evidence and
remaining work, independently of the Agents' terminal status labels. A
`completed` Receipt alone is not independent correctness or official benchmark
evidence. Runtime activity and an idle Agent are not proof that the user outcome
is achieved.

`codeflow exec` remains a single-executor convenience/baseline, not outer-loop
orchestration. Old `codemark` Manager live tests are retired; historical report
reading is not a measurement of this architecture.
