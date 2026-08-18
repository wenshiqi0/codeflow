# Handoff contract

A handoff is one unit of work moved from a delegator to a receiver, together with its goal, boundary, and acceptance criteria. The receiver owns its state until terminal.

## The rule that makes it work

**State changes and state queries are programmatic; requirement expression and orchestration go through models.**

The CLI owns every transition, sequence number, receipt validation, and event delivery. Models write handoff bodies, receipt narratives, and diagnoses — never `state.json`, event files, `active/` sentinels, or liveness records.

The reason is failure-mode asymmetry. State that depends on a model remembering to write it fails silently and unrecoverably: you end up with a run whose recorded state is a plausible fiction. State written by the CLI fails loudly at the moment of the mistake.

## States

```text
open -> running -> done(PASS|FAIL)
                \-> blocked(reason)
```

Terminal states are immutable. Re-finishing a terminal handoff is rejected as an illegal transition rather than overwriting the record.

`codeflow exec` opens a depth-0 root handoff for its planner. If the depth-0 runner exits while that handoff is still active, the mechanical layer closes every still-active handoff as `BLOCKED` with `DELEGATION_ARTIFACT_MISSING`, emits the terminal business event, and only then emits `runner_exited`. A prose final message is never promoted to success.

## Commands

```bash
code-agent handoff open   --role <role> --body-file <path> [--depth N] [--scope PATH]...
code-agent handoff start  --id <id> [--pid N]
code-agent handoff finish --id <id> --status <PASS|FAIL|BLOCKED> --summary "<one line>" \
                        [--receipt <file>] [--artifact <path>]... [--blocked-reason <enum>]...
code-agent handoff status --run-id <id> [--id <handoff-id>]
code-agent handoff list   [--active]
code-agent roster    [--format lines|json]
```

## Receipts

A `PASS` or `FAIL` on a delegated handoff requires a validated receipt file. A final assistant message is not a receipt — without the finish command, the delegation is recorded `BLOCKED` with `DELEGATION_ARTIFACT_MISSING`.

`BLOCKED` needs no receipt file: the reason enum *is* the receipt.

Validated fields:

| Field | Type | Notes |
| --- | --- | --- |
| `status` | enum | Required. Must match `--status`, or the finish is rejected |
| `command` | string | Required for `verify` |
| `exit_code` | int | Required for `verify` |
| `failed_checks` | array | Failing test names or gates |
| `error_excerpt` | string | Spilled to `evidence/` past 2000 chars and replaced with a ref |
| `reproduction` | string | Minimum command to reproduce |
| `diagnosis` | string | Marked as inference, not fact |
| `next_owner` | string | `tester`, `coder`, `planner`, or `environment` |
| `expected_red` | bool | Intended test-first failure; does not turn `FAIL` into `PASS` |
| `failure_class` | enum | Optional; clean `PASS` entries omit it |
| `facts` | array | Shared facts for later roles — see `facts.md` |

Multiple commands go in a `receipts` array with the overall status at top level;
the field is always an array rather than an object keyed by id. Each entry may
carry its `id`. Overall `PASS` requires every entry to pass, while any failing
entry makes the aggregate `FAIL`.

Single clean pass:

```json
{"status":"PASS","command":"bun test","exit_code":0}
```

Single failure:

```json
{"status":"FAIL","command":"bun test","exit_code":1,"failure_class":"POST_IMPLEMENTATION_FAIL"}
```

Batch:

```json
{"status":"PASS","receipts":[{"id":"unit","status":"PASS","command":"bun test","exit_code":0}]}
```

`--artifact` verifies a non-empty file exists on disk at finish time, so a delegator never has to take a role's word for it.

## Blocked reasons

A closed enum. Free-text prose is not an acceptable failure report.

| Reason | Meaning |
| --- | --- |
| `CONTEXT_BUDGET_EXCEEDED` | Protected context exceeded the model window; split the work |
| `DELEGATION_ARTIFACT_MISSING` | Mandatory artifact absent at finish |
| `OUTPUT_TRUNCATED` | Response ended `finish=length`; not an empty success |
| `PROVIDER_FAILURE` | Timeout, auth failure, quota, overload, transport error |
| `USER_CANCELLED` | Explicit cancellation |

Several may apply at once; pass `--blocked-reason` more than once. Any of these finishes the handoff `BLOCKED` — never an implicit retry, which would hide a real failure behind a second attempt.

## Events

Delivered by writing to `tmp/` then renaming into `events/`, so a reader never sees a partial file. **The filename is the primary metadata:**

```text
<seq>--<subject>--<kind>--<status>.json
```

Kinds: `run_started`, `run_finished`, `handoff_opened`, `handoff_finished`, `artifact_written`, `runner_exited`.

The event body is also a mechanical contract. `kind`, `status`, and every value in `reasons` must come from closed enums. `summary` is normalized to one bounded line. If it is absent, or the handoff ends in an error/truncation, the summary is built from the original log's first and last 100 characters, flattened to one line with obvious credentials redacted. Besides that bounded summary, identifiers, and pointers, no payload fields are allowed. `codeflow sub` exposes only filename metadata plus `reasons` and `summary`. A terminal provider signal is published as `handoff_finished BLOCKED` as soon as the delegation layer observes it, without waiting for the child process to drain and close.

Sequence numbers are allocated under an exclusive lock, so `--since` is a reliable watermark.

## Run layout

```text
.codeflow/runs/code/
├── _spool/                      run-level events for cross-run discovery
└── <run-id>/
    ├── handoffs/<handoff-id>/   handoff.md, state.json, receipt.json, title.txt
    ├── active/<handoff-id>      sentinel per in-flight handoff; `ls` answers "what now?"
    ├── events/                  the outer loop's only listening surface
    ├── tmp/                     staging; rename into events/ delivers
    ├── liveness/                watchdog heartbeats
    ├── facts.jsonl              this run's shared fact ledger
    └── runner.json              depth-0 pid and startup info
```

## Scope conflicts

A handoff may declare `--scope` paths. When two active handoffs claim overlapping scope, the CLI records `scope_conflicts` in `state.json` and warns. Treat it as a planning error and serialize the work — parallel roles editing the same file produce a diff nobody authored.
