# Codeflow Worker Contract

This contract is shared by every Codeflow worker. The handoff defines the work; this file defines the mechanical boundaries that make work auditable.

## Runtime and workspaces

`$PI_CODING_AGENT_DIR` is the Codeflow runtime and is read-only during a run. `$CODEFLOW_PROJECT_DIR` is the target project workspace, and `$CODEFLOW_EVIDENCE_DIR` is the run evidence workspace; both are writable for their intended files. Run state under the current run directory is mechanical state and is never edited directly.

Never expose, print, or commit secrets. Never push, force-reset, or clean the workspace without explicit authorization.

## Handoffs

A handoff is one unit of work from a delegator to a receiver. `code-agent handoff open/start/finish/status/list` owns every state transition, receipt validation, sequence, and event. A receiver writes handoff prose and receipt data through the CLI, never `state.json`, event files, active sentinels, or liveness records.

A terminal `PASS` or `FAIL` requires a validated JSON receipt. `BLOCKED` requires one or more closed blocked reasons and no receipt file. A root `PASS` additionally requires a non-empty JSON root receipt and a non-empty closure artifact. Summaries are one line.

If `handoff finish` rejects a receipt or artifact, the handoff remains non-terminal. Read the exact CLI error, repair that mechanical defect, and call finish once more. If the second call is rejected, stop and report both rejections. Business failures, command failures, provider failures, and execution timeouts are not CLI-validation failures.

## Evidence recorder

Execute evidence-bearing commands through the recorder rather than an unrecorded shell:

```bash
code-agent evidence run --id <id> [--timeout-ms <ms>] -- <command> [args...]
code-agent evidence receipt --output <receipt.json>
code-agent evidence log <id> [--head N] [--tail N] [--grep <pattern>]
```

A nonzero child exit is `FAIL`. A command that cannot start is `RUNNER_BLOCKED`. A command killed by its recorder timeout is `RUNNER_BLOCKED` with `error_class: "EXECUTION_TIMEOUT"` and exit code 124. The recorder owns the child process tree, writes complete bounded logs, and preserves earlier sibling records.

After an execution timeout, the registered handoff is already terminal `BLOCKED`. Return the structured result to the delegator without another terminal transition and without an implicit retry of the identical command.

Command receipts contain the command, integer exit code, and status. Batch receipts contain one entry per command, and batch `PASS` requires every entry to pass. Preserve complete stdout and stderr through the recorder; do not copy unbounded command output into a handoff body.

## Shared facts

Read the injected shared-fact ledger before redundant discovery. A fact locator identifies where a claim came from, not that a file still has the same content; reread a file before changing it.

Receipts may contribute at most 12 concise facts. Each fact needs a repository-relative `path` (optionally `line`), a `symbol`, or a literal `value`; paths are mechanically verified. Record established locations and conventions, not work narratives. A correction supersedes the earlier fact and states why. Never place secrets, file contents, or command output in the fact ledger.

## Collaboration recall

Collaboration history is pull-based. `code-agent handoff index` reads the ambient goal context; a cross-goal query passes `--goal-id`, and ungrouped history is the default when no ambient goal exists. `code-agent handoff get/body/receipt` retrieves an exact record. Index cards guide discovery; the handoff body, receipt, and state are authoritative.

Never grep, cat, tail, or otherwise content-scan `.codeflow/runs/`. Archived tool logs are retrieved only with `code-agent evidence log`.

## Product-work discipline

- Re-read a file before editing it.
- Do not weaken an assertion merely to make a test pass.
- Keep a failing command's observed result distinct from its expected result.
- Record a mistaken assumption and the exact correction when repairing evidence or tests.
- Put temporary artifacts, reproduction scripts, and generated data under `$CODEFLOW_EVIDENCE_DIR`, not the target repository.
- Run `code-agent check source` after implementation edits and before test execution.
- Inspect the final diff for unrelated changes, missing boundaries, unsafe behavior, and secrets before finishing.
- In the receipt, state only conclusions supported by the handoff body, repository evidence, or recorded command evidence.
