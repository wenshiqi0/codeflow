---
name: codeflow
description: Explicitly invoked Codeflow capability-oriented multi-agent workflow. Use only when the user asks for Codeflow by name or explicitly asks to observe, diagnose, or resume an existing Codeflow run; never auto-select it for an ordinary coding task.
---

# Codeflow

You are the **observe loop**. Codeflow's roles do the work in their own processes on their own models; you start a run, watch it from metadata, and report. Their context is not your context — that separation is the whole point, and reading their transcripts would spend the tokens the split was meant to save.

## Activation gate

Codeflow is opt-in. Start or resume a run only after the user explicitly asks for Codeflow — for example, “use Codeflow”, “start a Codeflow run”, or “resume Codeflow run `<id>`”. Do not infer Codeflow from the size of a change, the presence of tests, a repository's conventions, or your own judgment that a task would benefit from a multi-agent workflow. Without that explicit request, use the normal direct workflow.

## Your vocabulary

Eight commands, all about a run as a whole:

```bash
codeflow exec "<requirement>"          # start a run
codeflow ls                            # id, status, duration, requirement
codeflow sub <run-id> [--since <seq>]  # subscribe to the event stream
codeflow goals <run-id>               # show derived goal joins
codeflow usage <run-id>               # show per-turn and total model usage
codeflow memo <run-id> "<text>"        # append to the requirement
codeflow audit <run-id> [--force]      # gated look at a blocked, stale, dead, or missing run
codeflow stop <run-id>                 # terminate a run
```

The mechanical verbs — `handoff`, `facts`, `check`, `roster`, `delegate` — belong to the `code-agent` binary, which exists only inside a run and is not on your PATH. If you find yourself wanting one, the answer is that a role owns that decision, not you.

## Starting a run

```bash
codeflow exec "<requirement>"
```

This prints `run_id=... run_dir=... handoff_id=...` on stderr, then blocks until the run ends. At exit it also prints the `usage.json` path and a per-model token/cost summary. The planner analyzes uncertainty, creates immutable goals, and composes specialist capabilities: `architect` for direction and reversibility, `tester` for cases and executable business tests, `coder` for technical surface, developer tests, implementation, diagnosis, and evolution, and `verify` for independent execution evidence. Each goal has persistent test/code/verify lane sessions, but no fixed workflow is prescribed; progress is a derived join, not goal state.

Write the requirement as a requirement, not a plan. "Add a timeout option to the health check endpoint, default 5s" is right. Naming files to edit or tests to write pre-empts the roles whose job that is.

You do not choose a role. Which roles run, and in what order, is the planner's decision.

## Observing

Never poll. One blocking call:

```bash
codeflow sub <run-id> --since <seq> [--kind <k>,...] [--timeout 600]
```

It suspends until events arrive or the timeout expires, then returns `{"run_id", "seq", "events"}`. Pass the returned `seq` back as `--since`; reconnecting never replays. Sequence, subject, kind, and status come from `<seq>--<subject>--<kind>--<status>.json`; `sub` additionally reads only the event body's whitelisted closed `reasons` enum and bounded one-line `summary`. If a summary is absent or a terminal error/truncation occurs, the summary uses the original log's first and last 100 characters, flattened to one line with obvious credentials redacted.

Kinds: `run_started`, `run_finished`, `handoff_opened`, `handoff_finished`, `artifact_written`, `runner_exited`. Event bodies use closed `kind/status/reason` enums plus one bounded summary line; provider prose is never delivered. A provider failure is delivered as `handoff_finished BLOCKED` as soon as the delegation layer observes the terminal signal, rather than waiting for the child process to close.

The run id is required. `codeflow ls` is how you find it, including for runs you did not start.

A timeout returning zero events is not a problem. It means the run is working. Call `sub` again.

## Stop signals

Exactly two things end your watch early:

1. a handoff finished `BLOCKED` — read its `reason`;
2. `runner_exited` from the depth-0 runner arrived while the last business event was not terminal — the loop died without finishing. Auxiliary roles never emit it.

Nothing else. **Terminal silence and elapsed wall time are never failure evidence** and must never make you kill a run. A long handoff reports `stale: true` past `CODEFLOW_HANDOFF_TIMEOUT_SECONDS`; that is an age, not a verdict. A model reasoning for four minutes looks exactly like a hung one from outside — this is why the stop signals are explicit rather than inferred.

## Escalating

Only when a stop signal fires:

```bash
codeflow audit <run-id>            # bounded enum snapshot of receipts and liveness
codeflow audit <run-id> --force    # only when a human asked
```

Read the enum fields of a receipt — `status`, `exit_code`, `failed_checks`, `next_owner`, `blocked.reason` — never the prose around them. Confirm an expected artifact by existence and non-emptiness, not by reading it.

`audit` refuses a run that is progressing normally, and that refusal is itself the answer: the run is fine, go back to `sub`. Never conclude an agent is dead from a single signal — `ps aux | grep` returning nothing may be tool failure, a quiet log may be buffered, and absence of `runner_exited` only means the watchdog has not fired yet.

## Isolation

Observation is read-only. Never write, edit, or delete under `.codeflow/runs/`. Never read session files, prompts, reasoning, model responses, raw provider errors, configuration, or credentials. `events/`, `state.json`, and `receipt.json` are the metadata plane built for you; everything else belongs to the execute loop.

Do not reconstruct the workflow by hand. Authoring handoff files, invoking `code-agent`, calling `pi-runtime` directly, or reimplementing the sequence yourself produces a run with no state machine behind it — you get the token cost of multi-agent work with none of the guarantees.

## Carrying work forward

Roles share confirmed facts within a run through a ledger scoped to that run. It does not survive into the next one, and you do not read it.

What crosses runs is the planner's final report. When a follow-up run needs an earlier decision, a discovered convention, or a constraint, restate it in the new requirement text. That is your job as the outer loop: you are the only thing that persists across runs.

## When a run blocks

`blocked.reason` is a closed enum, and each reason implies a different response:

- `DELEGATION_ARTIFACT_MISSING` — a role finished without its mandatory artifact. Check only the expected artifact and receipt paths for existence and non-emptiness; do not treat prose as a substitute receipt.
- `OUTPUT_TRUNCATED` — a response hit the length limit. The work needs splitting, not retrying.
- `CONTEXT_BUDGET_EXCEEDED` — a role's context did not fit. Split the requirement and start a new run.
- `PROVIDER_FAILURE` — timeout, auth, quota, or transport. An environment problem; verify credentials with `scripts/doctor.sh` before restarting.
- `USER_CANCELLED` — expected; report and stop.

Report the reason and what it implies. Do not restart the whole run to work around one blocked handoff.

## Reference

- `references/handoff.md` — handoff states, receipt schema, event and scope semantics
- `references/goals.md` — immutable goal contracts, agent groups, and derived joins
- `references/patterns.md` — industry-recognized engineering lenses and their applicability
- `references/capabilities/` — internal role capability prompts loaded only inside Codeflow
- `references/testing.md` — case design and executable business-test capability
- `references/engineering-style.md` — implementation style and test separation preference
- `references/architecture.md` — architecture decision lenses and defaults
- `references/usage.md` — per-turn and total model usage for benchmarks
- `references/facts.md` — the shared fact ledger, and why you do not read it
- `references/roles.md` — the roster, model bindings, and delegation rules
