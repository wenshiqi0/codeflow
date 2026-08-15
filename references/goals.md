# Goals and agent groups

A goal is one observable outcome that planner carved from the requirement. An agent group is the fixed team pursuing that goal:

```text
test lane    → test-writer
code lane    → coder
verify lane  → test-runner
```

The goal contract is immutable metadata, not a state machine. It never stores `status`, `stage`, `result`, `active`, or `finished_at`.

## Contract

Location:

```text
.codeflow/runs/code/<run-id>/goals/<goal-id>/contract.json
```

Fields:

- `schema_version`;
- `id`;
- `goal`;
- `definition_of_done`;
- `created_at`;
- `lanes.test`;
- `lanes.code`;
- `lanes.verify`.

Each lane records its role and write roots. Changing an existing contract is rejected; create `<goal>-r2` instead.

## Sessions

Planner uses one session for the entire run:

```text
<run-id>-planner
```

A worker lane uses one deterministic session across all handoffs for that goal:

```text
<run-id>-<goal-id>-test
<run-id>-<goal-id>-code
<run-id>-<goal-id>-verify
```

Handoffs still open and close independently. Session continuity is context continuity, not a second state machine.

## Derived join

Read the current goal view with:

```bash
codeflow goals <run-id>
```

The view joins:

```text
goal contract
× handoffs carrying goal_id and lane
× receipts / artifacts referenced by those handoffs
```

`join.satisfied` is true only when the latest handoff in each required lane is `PASS`. Every status shown by the view is derived from handoff state and is never written back to the goal.
