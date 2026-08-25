# Benchmark contract

The benchmark evaluates project outcomes with the official SWE-bench
evaluator. Codeflow Receipts are diagnostic runtime facts and never replace the
official verdict.

Each attempt uses a fresh workspace and Task id. The model-visible input is the
allowlisted dataset projection only. Gold patches, evaluator results, and issue
lookup are never exposed to a Worker.

The append-only usage ledger records one completed assistant response as one
model round. Usage and privacy-safe tool-call rows carry only:

```text
task_id, goal_id, handoff_id, worker_kind, provider, model, timestamps, counts
```

Tool arguments, command text, tool results, model prose, and transcripts are
not benchmark telemetry. `worker_kind` is `worker` or internal `service`; it is
not a role or privilege marker.

Handoff telemetry is projected after an attempt from canonical
`handoff.json`, its append-only Receipt chain (`receipts/`, with a legacy
single `receipt.json` reading as one terminal Receipt), and Runtime
interruption events. Its projection uses the folded chain and the terminal
Receipt. Its statuses are:

```text
open | running | interrupted |
completed | partial | blocked | failed | superseded
```

Reports break usage and tool calls down by Goal, provider/model, and Worker
kind. Runtime observability reports Receipt statuses and Runtime failure
reasons by Goal. There are no role, thread, lane, depth, mutable state, legacy
schema, or compatibility-reader dimensions.

Wall time is telemetry rather than a ranking axis. Cache hit rate is
token-weighted and unavailable when any contributing round omitted cache
metrics. Infrastructure and evaluator failures remain distinct from unresolved
model outcomes. A missing result never shrinks the official verdict
denominator silently.
