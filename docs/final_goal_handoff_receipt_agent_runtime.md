# Goal-Scoped Handoff / Receipt Agent Runtime

Status: Final architecture baseline.

## Semantic model

```text
Task (the Goal Graph root)
  -> Child Goal DAG (only when decomposition is useful)
  -> Handoff
  -> free Execution
  -> observable Effect
  -> Receipt
  -> reduced Goal State / Task State
```

The Runtime persists only `Task`, child `Goal`, `Handoff`, and `Receipt`.
`Effect` is stored as a natural reference inside a Receipt. Context, tool
observations, hypotheses, reasoning, conversation history, and checkpoints are
not durable semantic state.

## Task is the root Goal

A Task is the caller's stable, high-dimensional objective and the root of its
Goal Graph. Root and unsplit work use `goal_id = task_id`. The Runtime must not
create a default, root, ungrouped, or compatibility Goal. Persisted Goal records
represent child outcome scopes only.

Child Goals are dynamic, schedulable, dependency-aware, recallable outcome
scopes. Dependencies form a DAG and express result prerequisites, not workflow
steps. A Goal is not a phase, plan step, role, prompt, Worker, branch, or PR.

## Equal Workers and capability

Every executing Agent is a Worker. There are no permanent planner, coder,
tester, verifier, reviewer, or supervisor identities and no prescribed phase
sequence. A Worker may inspect, edit, test, debug, review, and verify within one
Handoff.

The root Worker is not a separate type. Its additional organization ability is
a fact of the tools loaded by the Runtime. Capability is never duplicated as a
prompt claim, role registry, or depth field visible to the model.

## Handoff and Receipt

A Handoff opens one bounded Work Commitment inside one Goal. It contains:

- `task_id`, `goal_id`, `digest`, and `intent`;
- relevant known state and external references;
- outcome constraints and expected outcomes;
- evidence expectations where relevant;
- optional parent Handoff identity.

One Handoff may carry an append-only chain of immutable Receipts. Each Receipt
is an incremental semantic delta — never a snapshot or checkpoint — and uses
one of:

```text
progress                                            (non-terminal)
completed | partial | blocked | failed | superseded  (terminal)
```

A `progress` Receipt advances durable semantics without closing the Handoff;
only a terminal Receipt closes it and finishes the root run. A Receipt contains
only natural Effect references and the minimum durable semantic result:
`established`, `decisions`, `discovered`, `unresolved`, and `blockers`, plus
Goal-scoped resolution references that supersede or resolve earlier facts by
their stable identity, including facts from an earlier Handoff in the same
Goal, so folded state never accumulates stale values. Existing schema-v1
`handoffs/<id>/receipt.json` records read as exactly one terminal Receipt.
A Receipt is not a validation gate, transcript, diary, diff, log, artifact
container, or checkpoint.

Constraints belong in the Handoff. Independent verification is a later
Handoff, usually in a fresh Worker context.

## Identity and ordering

Handoffs and Receipts use byte-stable canonical JSON and SHA-256 content
identity. They share one monotonic semantic sequence. History is ordered by
logical sequence, with content hash only as a tie-breaker. Existing semantic
records are immutable and append-only. Folding reduces a Receipt chain
deterministically in sequence order, applying resolution references so
resolved or superseded facts disappear from the folded state.

## Context and Recall

The default working set is pull-first and bounded. It contains only:

```text
Worker prior
Task
Reduced root Goal state
Reduced current Goal state (child Goals)
Current Handoff
Current Handoff folded Receipt state
Receipt head metadata
Explicit recall and ephemeral tool observations
```

Full root or current-Goal Handoff/Receipt history is never injected. Recall is
explicit for a Goal, a Handoff, or an exact Receipt, with compact `state` or
`semantic` levels by default and `full` only on request. Goal `semantic`
returns the latest relevant Handoff, its Receipt head, and its folded semantic
state; because Receipts are deltas, returning only the newest raw Receipt would
lose earlier unresolved semantics. The complete incremental chain is therefore
reserved for `full`. Same-goal lookup may use the ambient scope; cross-goal
lookup must be explicit. Mutable reduced state follows the stable append-only
prefix.

Every spawned Worker starts a fresh Pi context. No session continuity,
checkpoint, compact state, context seed, facts ledger, or collaboration index
participates in recovery.

## Failure and recovery

Semantic `partial`, `blocked`, and `failed` outcomes have Receipts when the
Worker can make a grounded conclusion. Process crash, provider failure, tool
failure, cancellation, context exhaustion, and missing model output are Runtime
failures and must not create a Receipt.

An attempt ends with `run_finished` when the root Handoff has a terminal
Receipt, or `run_interrupted` when it does not; `runner_exited` follows either
terminal event. A process that ends after durable progress — a recorded
Receipt chain without a terminal Receipt — is a missing-terminal-Receipt
interruption, not a missing delegation artifact. A resume requires this complete lifecycle. An interrupted Handoff is
re-executed from its original contract, inherited/local durable semantics,
current external state, and observed Effects. No old reasoning is restored.

`No Receipt` means only `No accepted semantic conclusion`; it does not imply
that no external Effect occurred.

## Effects

Prefer references in this order:

```text
Git ref -> file path -> external id -> service reference -> minimal semantic description
```

Do not build Effect providers, adapters, registries, or lifecycle managers.
Git and other external systems remain the authoritative representation of
their own state.

## Observability

Observability projects canonical Task/Goal/Handoff/Receipt state and Runtime
events. Usage and tool rows are attributed by `task_id`, `goal_id`,
`handoff_id`, `worker_kind`, provider, and model. It must not reintroduce
roles, depth, threads, lanes, mutable `state.json`, or PASS/FAIL Receipt gates.

Recommended metrics include goals per Task, Handoffs per Goal, Workers per
Task, tokens per Handoff, cross-Goal Recall rate, interrupted Handoff rate,
Receipt failure rate, context pressure, runtime exploration, cache hit rate,
prefix invalidation, and cost per accepted state transition.

## Invariants

1. Task is the Goal Graph root and uses its own id as root `goal_id`.
2. Child Goals are outcome scopes in an acyclic dependency graph.
3. Worker capability equals its actual Runtime tool surface.
4. Workflow emerges from execution history; it is not prescribed.
5. Handoff/Receipt is the only formal work protocol.
6. A Handoff plus its folded Receipt chain is the smallest durable recoverable work unit; only a terminal Receipt closes it.
7. Runtime failure never fabricates a Receipt, and durable progress distinguishes interruption causes.
8. Context is disposable; intermediate cognition is never persisted.
9. Reduced root Goal state is inherited; full history and sibling Goal detail
   require explicit recall.
10. Handoff/Receipt bytes are canonical, content-addressed, and append-only.
