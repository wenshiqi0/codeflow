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

## Commands

```bash
codeflow handoff open   --role <role> --body-file <path> [--depth N] [--scope PATH]...
codeflow handoff start  --id <id> [--pid N]
codeflow handoff finish --id <id> --status <PASS|FAIL|BLOCKED> --summary "<one line>" \
                        [--receipt <file>] [--artifact <path>]... [--blocked-reason <enum>]...
codeflow handoff status --run-id <id> [--id <handoff-id>]
codeflow handoff list   [--active]
codeflow agents list    [--format lines|json]
```

## Receipts

A `PASS` or `FAIL` on a delegated handoff requires a validated receipt file. A final assistant message is not a receipt — without the finish command, the delegation is recorded `BLOCKED` with `DELEGATION_ARTIFACT_MISSING`.

`BLOCKED` needs no receipt file: the reason enum *is* the receipt.

Validated fields:

| Field | Type | Notes |
| --- | --- | --- |
| `status` | enum | Required. Must match `--status`, or the finish is rejected |
| `command` | string | Required for `test-runner` |
| `exit_code` | int | Required for `test-runner` |
| `failed_checks` | array | Failing test names or gates |
| `error_excerpt` | string | Spilled to `evidence/` past 2000 chars and replaced with a ref |
| `reproduction` | string | Minimum command to reproduce |
| `diagnosis` | string | Marked as inference, not fact |
| `next_owner` | string | `test-writer`, `coder`, `planner`, or `environment` |
| `expected_red` | bool | Intended test-first failure; does not turn `FAIL` into `PASS` |
| `facts` | array | Shared facts for later roles — see `facts.md` |

Multiple commands go in a `receipts` array with the overall status at top level. Overall `PASS` requires every entry to pass.

`--artifact` verifies a path exists on disk at finish time, so a delegator never has to take a role's word for it.

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

Delivered by writing to `tmp/` then renaming into `events/`, so a reader never sees a partial file. **The filename is the metadata:**

```text
<seq>--<subject>--<kind>--<status>.json
```

Kinds: `run_started`, `run_finished`, `handoff_opened`, `handoff_finished`, `artifact_written`, `runner_exited`.

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
