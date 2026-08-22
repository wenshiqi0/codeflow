---
name: codeflow
description: Explicitly invoked Codeflow equal-worker orchestration workflow. Use only when the user asks for Codeflow by name or explicitly asks to observe, diagnose, or resume an existing Codeflow run; never auto-select it for an ordinary coding task.
---

# Codeflow

You are the **observe loop**. Codeflow workers run in their own processes with their own context; you start a run, watch metadata, and report. Their context is not your context, and reading their transcripts would spend the tokens the process split was meant to save.

## Activation gate

Codeflow is opt-in. Start or resume a run only after the user explicitly asks for Codeflow — for example, “use Codeflow”, “start a Codeflow run”, or “resume Codeflow run `<id>`”. Do not infer Codeflow from the size of a change, repository conventions, tests, or your own judgment that delegation would help. Without that explicit request, use the normal direct workflow.

## Vocabulary

```bash
codeflow exec "<requirement>"          # start a run
codeflow resume <run-id>               # resume a fully stopped run in place
codeflow ls                            # id, status, duration, requirement
codeflow sub <run-id> [--since <seq>]  # subscribe to the event stream
codeflow goals <run-id>               # show goal grouping statistics
codeflow usage <run-id>               # show model-round and token usage
codeflow memo <run-id> "<text>"        # append to the requirement
codeflow audit <run-id> [--force]      # gated look at a blocked, stale, dead, or missing run
codeflow stop <run-id>                 # terminate a run
```

The mechanical verbs — `handoff`, `facts`, `check`, `roster`, `delegate` — belong to `code-agent`, which exists only inside a run. A worker owns those decisions, not the observe loop.

## Starting and resuming

`codeflow exec "<requirement>"` prints `run_id=... run_dir=... handoff_id=...`, then blocks until the run ends. It exits with the `usage.json` path and a per-model token/cost summary. The root worker may work directly or use goal/task tools; organization is optional and no fixed ceremony exists. A goal groups collaboration history and names thread sessions; it has no mechanical completion gate. Report goals, threads, and process depth through metadata rather than assigning worker identities.

Write the requirement as a requirement, not an implementation plan. “Add a timeout option to the health check endpoint, default 5s” is correct; naming files and edits pre-empts the worker's handoff decisions.

Resume only a fully stopped run after a human explicitly asks. Resume keeps the run id, original requirement, root session, goal/thread sessions, facts, and evidence history, then opens a new root handoff. It refuses until the latest attempt emits both `run_finished` and `runner_exited`; it is never an automatic retry and never changes failure into success.

## Observing

Never poll. Use one blocking call:

```bash
codeflow sub <run-id> --since <seq> [--kind <k>,...] [--timeout 600]
```

Pass the returned `seq` back as `--since`; reconnecting never replays. Events carry closed enums and a bounded, redacted summary only. Kinds include `run_started`, `run_resumed`, `handoff_opened`, `handoff_finished`, `artifact_written`, and `runner_exited`. A timeout returning zero events means the run is still working; call `sub` again with the latest sequence.

Report from `run_dir` metadata and bounded CLI output, never by reading worker transcripts, prompts, receipts, state files, or event bodies directly. Use `codeflow goals` for goal/thread statistics and `codeflow usage` for model rounds and token consumption. Correctness comes from the run verdict and evidence, not from how busy workers appeared.

## Failure and completion

`BLOCKED` is terminal for that handoff. `EXECUTION_TIMEOUT` means a recorded command exceeded its per-command timeout and the worker returns control to its delegator; it never silently reruns the identical command. Root `PASS` requires a summary, non-empty JSON root receipt, and non-empty closure artifact. Grouped goal state never gates that transition.

If infrastructure fails, report the exact run id, event sequence, and blocked reason. Do not edit Codeflow runtime state, rerun a benchmark, or retry a provider from the observe loop unless the user explicitly asks for that separate action.
