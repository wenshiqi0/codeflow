# Codeflow Worker Contract

Every execution agent is an equal Worker. The current Handoff is the complete
work commitment; there are no permanent planner, coder, tester, verifier, or
reviewer identities and no prescribed phase sequence.

## Durable protocol

The Runtime persists only Task, Goal, Handoff, and Receipt semantics. Context,
tool observations, hypotheses, and reasoning are temporary.

- A Task is the high-dimensional root Goal. Its id is also the `goal_id` for
  root and unsplit work.
- Child Goals are outcome, dependency, scheduling, and recall scopes.
- A Handoff opens one bounded commitment. Its constraints describe what must
  remain true, not which files or tools a Worker may use.
- A Receipt closes exactly one Handoff. Submit it with the `receipt` tool using
  `completed`, `partial`, `blocked`, `failed`, or `superseded`.
- Effects reference observable external state using Git refs, file paths,
  external ids, service references, or a minimal semantic description. Do not
  copy diffs or logs into a Receipt.

Failed, blocked, and partial work still receives a Receipt when the Worker can
form a grounded semantic conclusion. A process crash, provider failure, tool
infrastructure failure, cancellation, or context exhaustion is a Runtime event
and must not be converted into an invented Receipt.

## Context and recall

The injected working set contains the Task, root Handoff/Receipt history, the
current Goal's local history, reduced Goal state, and the current Handoff.
Sibling Goal state is not implicit. Use `recall(goal_id, level)` explicitly;
start with `state` or `semantic`, and request `full` only when needed.

Do not create checkpoints, conversation summaries, continuation files, or
private memory. Re-ground an interrupted Handoff from its original contract,
durable Receipts, Effect references, and current external state.

## Engineering boundaries

- Never expose, print, or commit secrets.
- Never push, force-reset, clean, or perform an irreversible external action
  without explicit authorization.
- Re-read a file before changing it and do not weaken assertions to make tests
  pass.
- Put temporary logs and generated evidence under `$CODEFLOW_EVIDENCE_DIR`.
- Use `code-agent evidence run` for evidence-bearing commands and keep complete
  output external; use bounded retrieval when diagnostics are needed.
- Run `code-agent check source` after edits and inspect the final diff.

## Delivery obligations

Obligations bind the Receipt, not the path taken to reach it.

- A `completed` Receipt for a behavior change must reference regression
  evidence under `$CODEFLOW_EVIDENCE_DIR`: which relevant existing tests ran
  and their outcome. If no covering tests exist, state that in `discovered`
  or `unresolved` — never silently.
- A bug fix must reference a reproduction that failed before the change and
  passes after it.
- When a change alters what a function returns, fetches, or guarantees,
  enumerate its downstream consumers by file or symbol and record the
  compatibility conclusion in `established`.
- An obligation judged inapplicable requires a one-line reason in the
  Receipt; silent omission is a `partial`, not a `completed`.
