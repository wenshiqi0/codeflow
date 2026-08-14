---
name: codeflow
description: Run a test-first multi-agent coding workflow, where specialized roles on separate models write failing tests, implement, and verify a change under a handoff protocol. Use when a code change deserves proven tests rather than a direct edit, or when observing, diagnosing, or resuming a codeflow run that is already in progress.
---

# Codeflow

You are the **observe loop**. Codeflow's roles do the work in their own processes on their own models; you start a run, watch it from metadata, and report. Their context is not your context — that separation is the whole point, and reading their transcripts would spend the tokens the split was meant to save.

## Starting a run

```bash
codeflow run --agent planner "<requirement>"
```

This prints `run_id=... run_dir=... handoff_id=...` on stderr, then blocks until the run ends. The planner analyzes the requirement, then delegates: `test-writer` writes failing tests, `test-runner` proves RED, `coder` implements, `test-runner` proves GREEN, `test-writer` reviews the diff.

Write the requirement as a requirement, not a plan. "Add a timeout option to the health check endpoint, default 5s" is right. Naming files to edit or tests to write pre-empts the roles whose job that is.

For an explicit one-off operation that needs no planning — a branch, a commit, a status check — skip the workflow:

```bash
codeflow command "<operation>"
```

## Observing

Never poll. One blocking call:

```bash
codeflow wait --run-id <id> --since <seq> [--kind <k>,...] [--timeout 600]
```

It suspends until events arrive or the timeout expires, then returns `{"run_id", "seq", "events"}`. Pass the returned `seq` back as `--since`; reconnecting never replays. Every field comes from the event filename — `<seq>--<subject>--<kind>--<status>.json` — so reading a body is the exception.

Kinds: `run_started`, `run_finished`, `handoff_opened`, `handoff_finished`, `artifact_written`, `runner_exited`.

Without `--run-id` it watches the shared spool for run-level events, which is how you discover runs you did not start.

A timeout returning zero events is not a problem. It means the run is working. Call `wait` again.

## Stop signals

Exactly two things end your watch early:

1. a handoff finished `BLOCKED` — read its `reason`;
2. `runner_exited` from the depth-0 runner arrived while the last business event was not terminal — the loop died without finishing. Auxiliary roles never emit it.

Nothing else. **Terminal silence and elapsed wall time are never failure evidence** and must never make you kill a run. A long handoff reports `stale: true` past `CODEFLOW_HANDOFF_TIMEOUT_SECONDS`; that is an age, not a verdict. A model reasoning for four minutes looks exactly like a hung one from outside — this is why the stop signals are explicit rather than inferred.

## Escalating

Only when a `handoff_finished` status warrants a closer look:

```bash
codeflow handoff status --run-id <id> [--id <handoff-id>]   # one receipt, or all active
codeflow agents list                                        # role, depth, heartbeat age, title, scope
codeflow probe                                              # one-line liveness (0=alive, 1=exited, 2=unknown)
```

Read the enum fields of a receipt — `status`, `exit_code`, `failed_checks`, `next_owner`, `blocked.reason` — never the prose around them. Confirm an expected artifact by existence and non-emptiness, not by reading it.

Never conclude an agent is dead from a single signal. `ps aux | grep` returning nothing may be tool failure; log size may be buffered or filtered; absence of `runner_exited` only means the watchdog has not fired yet. Use `codeflow agent-status`, and require at least two independent signals.

## Isolation

Observation is read-only. Never write, edit, or delete under `.codeflow/runs/`. Never read session files, prompts, reasoning, model responses, raw provider errors, configuration, or credentials. `events/`, `state.json`, and `receipt.json` are the metadata plane built for you; everything else belongs to the execute loop.

Do not reconstruct the workflow by hand. Authoring handoff files, calling `pi-runtime` directly, or reimplementing the sequence yourself produces a run with no state machine behind it — you get the token cost of multi-agent work with none of the guarantees.

## Carrying work forward

Roles share confirmed facts within a run through a ledger scoped to that run. It does not survive into the next one, and you do not read it.

What crosses runs is the planner's final report. When a follow-up run needs an earlier decision, a discovered convention, or a constraint, restate it in the new requirement text. That is your job as the outer loop: you are the only thing that persists across runs.

## When a run blocks

`blocked.reason` is a closed enum, and each reason implies a different response:

- `DELEGATION_ARTIFACT_MISSING` — a role finished without its mandatory artifact. Check `state.summary`: work that was actually completed but never recorded needs only the finish step re-run.
- `OUTPUT_TRUNCATED` — a response hit the length limit. The work needs splitting, not retrying.
- `CONTEXT_BUDGET_EXCEEDED` — a role's context did not fit. Split the requirement and start a new run.
- `PROVIDER_FAILURE` — timeout, auth, quota, or transport. An environment problem; verify credentials with `scripts/doctor.sh` before restarting.
- `USER_CANCELLED` — expected; report and stop.

Report the reason and what it implies. Do not restart the whole run to work around one blocked handoff.

## Reference

- `references/handoff.md` — handoff states, receipt schema, event and scope semantics
- `references/facts.md` — the shared fact ledger, and why you do not read it
- `references/roles.md` — the roster, model bindings, and delegation rules
