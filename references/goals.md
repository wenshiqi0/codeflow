# Goals and capability lanes

A goal is one observable outcome carved from the requirement. Its contract is immutable metadata; status is derived from terminal handoffs.

```text
test lane    -> tester
code lane    -> coder
verify lane  -> verify
```

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
- lane ownership for test, code, and verify.

Lane sessions persist across handoffs for context continuity. Handoffs remain independently terminal. Keep one active handoff per lane.

## Derived join

Read current goal views with:

```bash
codeflow goals <run-id>
```

The view joins goal contracts with handoffs carrying the same `goal_id` and lane. `join.satisfied` is true only when the latest handoff in each required lane is `PASS`. Status is derived from handoff state and receipts, never written back to the goal.

A root handoff cannot finish `PASS` while any goal join is unsatisfied. A planner that sees that mechanical rejection must either delegate the missing lane, revise the goal with a new immutable contract, or close the root with the observed non-PASS outcome.

Changing a goal requires a new immutable contract, conventionally `<goal-id>-r2`, with a supersedes note.
