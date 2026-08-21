# Codeflow Agent Instructions

Worker-only shared contract. Role policy is in `roles.json`; exact role prompts are in `references/capabilities/`. The observe loop belongs to the outer coordinator.

## Runtime location

`$PI_CODING_AGENT_DIR` is the Codeflow runtime root; its parent is the installed Codeflow Skill root. Both may be inspected when Codeflow behavior itself needs diagnosis, but they are host-owned and read-only during a business run. Do not edit them or confuse them with the target product repository.

## Handoff contract

Coordination happens in handoffs: one unit of work from a delegator to a receiver, who maintains its state until terminal. Planner authors a concise outcome contract; vague requests are invalid.

State changes and queries are programmatic; requirement expression goes through models. `code-agent handoff open/start/finish/status/list` owns every transition (`open` -> `running` -> `done(PASS|FAIL)` or `blocked(reason)`), sequences, receipt validation, and events. Models write handoff bodies, receipt narratives, and diagnoses. Never hand-write `state.json`, event files, `active/` sentinels, or liveness records; never claim liveness in prose. Scope conflicts persist as `scope_conflicts` in `state.json`.

A `PASS` or `FAIL` needs a validated receipt file: `code-agent handoff finish --id "$CODEFLOW_HANDOFF_ID" --status <STATUS> --receipt <file> --artifact <path> --summary "<one line>"`. A final message is not a receipt. `BLOCKED` needs no receipt file; the enum is the receipt. `blocked.reason` is one of `CONTEXT_BUDGET_EXCEEDED`, `DELEGATION_ARTIFACT_MISSING`, `EXECUTION_TIMEOUT`, `OUTPUT_TRUNCATED`, `PROVIDER_FAILURE`, `USER_CANCELLED`. Pass `--blocked-reason` more than once when several apply.

If `handoff finish` is rejected by CLI validation — for example invalid receipt JSON, a missing fact path, or an empty artifact — the handoff is still non-terminal. Read the exact CLI error, repair only that mechanical defect, and call `handoff finish` once more in this same handoff. If the second call is also rejected, stop and report the rejection honestly; do not keep retrying. This repair rule does not apply to business failures, test failures, provider failures, or execution timeouts.

## Shared facts

You run in a fresh process with no memory of earlier roles. What you do get is the `<shared_facts>` block in your injected context: locators earlier roles in this run confirmed and recorded. Read it before searching. If it already names the file you need, go straight there instead of grepping for it.

Trust a fact's locator, but re-read a file before you change it — the fact proves where something was, not that it is still shaped the way you assume.

Contribute what the next role would otherwise have to rediscover by adding a `facts` array to your receipt:

```json
{
  "status": "PASS",
  "facts": [
    {"claim": "route registration entry", "path": "src/router.ts", "line": 42},
    {"claim": "test framework", "value": "vitest"}
  ]
}
```

Rules that keep the ledger worth reading:

- Every fact needs a locator: a real repository-relative `path` (optionally with `line`), a `symbol`, or a literal `value`. The CLI verifies paths exist and rejects the whole finish if one does not.
- Record established locations and conventions, not your process. "Checked three files" is not a fact.
- At most 12 facts per handoff, each claim one short line.
- Found an injected fact to be wrong? Append a correction rather than arguing in prose: `{"supersedes": "f1", "claim": "...", "path": "...", "reason": "why it changed"}`. History is never rewritten; the superseded fact simply stops being shown.

The ledger lives and dies with this run. Do not treat it as durable knowledge, and never put secrets, file contents, or command output in it.

## Engineering rules

- Never expose, print, or commit secrets.
- Never weaken assertions merely to make a test pass.
- Do not push, force-reset, or clean the workspace without explicit authorization.
- Put temporary run artifacts below `.codeflow/runs/`.
- Never grep, cat, tail, or otherwise content-scan `.codeflow/runs/`. State queries go through `code-agent handoff status/list` and artifact-existence checks only; run-artifact bodies are not agent input. Shared facts reach you through injected context, not by reading `facts.jsonl`.
- Explicit provider timeout, authentication failure, quota exhaustion, overload, transport failure, or user cancellation finishes a handoff `BLOCKED`; never an implicit retry. Silence while a provider queues is not failure evidence.
- A verification command killed by its per-command timeout (`code-agent evidence run` exit 124, `error_class: "EXECUTION_TIMEOUT"`) is mechanically recorded and finishes the current handoff `BLOCKED`; return the result to the planner without another terminal transition. Never implicitly retry the same timed-out command — splitting the command, changing the timeout or environment, or redelegating is a planner decision, not a coder or verify one.
- A delegated response ending with `finish=length` is output truncation, not an empty success. When its mandatory artifact is absent it is `BLOCKED` with both truncation and missing-artifact reasons; do not silently retry inside the same handoff.
- Run `code-agent check source` after implementation edits and before test execution.
