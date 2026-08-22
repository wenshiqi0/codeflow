# Goals and threads

A goal is an immutable grouping label for related handoffs and collaboration history. It carries no mutable state and no mechanical completion gate.

```text
.codeflow/runs/code/<run-id>/goals/<goal-id>/contract.json
```

Fields:

- `schema_version`;
- `id`;
- `goal`;
- `definition_of_done`;
- `created_at`.

`definition_of_done` is documentation for people and workers. A goal view reports handoff counts and status distributions only.

## Threads

`goalSessionId(runId, goalId, thread)` names a persistent worker session:

- same goal and thread continue the session;
- a different thread starts a fresh session;
- one active handoff is allowed per goal/thread pair;
- a task without `goal_id` runs in `_ungrouped`.

Root `PASS` depends on the root receipt and closure artifact, not on grouped handoff states.
