# Benchmark contract

The benchmark evaluates project outcomes with the official SWE-bench
evaluator. Codeflow Receipts are diagnostic runtime facts and never replace the
official verdict.

The official evaluator uses the dedicated Python at
`$CODEFLOW_BENCHMARK_HARNESS_CACHE/swebench-venv/bin/python3` by default.
`CODEFLOW_BENCHMARK_HARNESS_PYTHON` may select another SWE-bench environment.
The wrapper validates that exact interpreter and its Docker SDK before invoking
the harness; it never relies on an unrelated `python3` from `PATH`.

Each attempt uses a fresh workspace and Task id. The model-visible input is the
allowlisted dataset projection only. Gold patches, evaluator results, and issue
lookup are never exposed to a Worker.

Workspace provisioning prefers a read-only source clone containing the requested
commit and tree at `$CODEFLOW_BENCHMARK_REPO_CACHE_DIR/<repo-name>` and otherwise checks
`$HOME/Documents/swe/<repo-name>` before cloning GitHub. Every attempt still
gets a separate workspace at the dataset `base_commit`; after materializing the
tree, provisioning replaces Git history with one synthetic baseline commit so
the Worker cannot inspect later upstream history. Provisioning never fetches
into or otherwise mutates the source cache.

The append-only usage ledger records one completed assistant response as one
model round. Usage and privacy-safe tool-call rows carry only:

```text
task_id, goal_id, commitment_id, worker_kind, provider, model, timestamps, counts
```

Tool arguments, command text, tool results, model prose, and transcripts are
not benchmark telemetry. `worker_kind` is `worker` or internal `service`; it is
not a role or privilege marker.

Commitment telemetry is projected after an attempt from canonical
`commitment.json`, its append-only Receipt chain under `receipts/`, and Runtime
interruption events. Its projection uses the folded chain and the terminal
Receipt. Its statuses are:

```text
open | running | interrupted |
completed | blocked
```

Reports break usage and tool calls down by Goal, provider/model, and Worker
kind. Runtime observability reports Receipt statuses and Runtime failure
reasons by Goal. There are no role, thread, lane, depth, mutable state, or
alternate-schema dimensions.

Tool operations separate `source_discovery` from validation and integration.
Source discovery covers bounded reads and repository searches. Validation is
the sum of direct execution, evidence runs, evidence reads, and source checks.
Integration covers `inspect`, `claim`, `report`, `delegate`, and `wait`.
The report does not infer a redundant-discovery rate from these unlike
activities.

Wall time is telemetry rather than a ranking axis. Cache hit rate is
token-weighted and unavailable when any contributing round omitted cache
metrics. Infrastructure and evaluator failures remain distinct from unresolved
model outcomes. A missing result never shrinks the official verdict
denominator silently.

Run-facts telemetry uses schema version 3. Before every provider request it
records privacy-safe shapes for the system prompt, active tool schema, injected
Worker context, and message prefix. Each shape contains only a hash and character
count; the tool schema additionally records tool count, and Worker context lists
section shapes. Reports separate system-prompt, tool-schema, and Worker-context
changes from message-prefix invalidations instead of treating all prefix movement
as one cause. They also expose component sizes and maximum observed context
utilization.

The observation ledger is written on every request, but model-visible
`run_facts` is appended only when utilization first crosses 50%, 70%, or 85%.
This keeps the measurement complete without creating a new changing prefix on
every round.
