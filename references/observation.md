# Persistent observation in an asynchronous host

`codeteam watch` owns the activity loop. Keep one observation process per Task,
including idle periods between assignments. Its NDJSON records carry
caller-authored instructions and public events, never a Pi transcript. Usage-only
growth extends per-execution patience without producing output. `attention` and
`settled` are notifications, not process exit or Task completion.

## Default: one quiet background process

```bash
codeteam watch <task-id> --quiet
```

Start it with whatever the host uses for background commands — Claude Code's
background Bash, a detached `exec_command` session, `nohup`, a job runner — and
go back to useful work. While the Task runs, the process writes nothing to
stdout, so no model attention is spent on it. Every message still lands in
`<run>/watch.ndjson` (`--log <path>` moves it).

The process ends only when the Task finishes, when an execution's process dies
or loses its identity, when an execution is interrupted, or when you cancel it.
It then prints one line:

```json
{"schema_version":1,"task_id":"task-…","type":"watch_result","outcome":"finished",
 "status":"completed","summary":"…","remaining":[],"last_seq":41,
 "attention":[],"agents":[…],"log":"…/watch.ndjson","exit_code":0}
```

| exit | meaning |
| --- | --- |
| 0 | Task `completed`, or an observer you cancelled |
| 2 | Task `blocked`; `remaining` explains what is left |
| 3 | Runtime interruption: process missing, identity mismatch, interrupted execution |
| 4 | settled: the Task is open, nothing is executing, the outer loop must decide |
| 1 | another failure; stderr carries the message |

Exit code 3 is the reason a quiet watch exists: a dead Worker reaches the outer
loop as a process exit rather than as a line nobody is reading. It means the
execution needs inspection, not that the work failed, and never that a Receipt
should be invented. Reconcile with `status` and `inspect`, then decide whether
to `resume`.

Exit `4` is the end of an assignment round, not an error: every Agent is idle or
interrupted, no process is alive, and the Task stays open until the outer loop
runs `followup`, `spawn`, or `finish`. Take the decision, then start the next
watch with `--since <last_seq>`. A Task that has never assigned work is not
settled — a watch started before the first assignment keeps waiting — and
`--stay-on-settled` restores the older behavior of holding one process across
idle periods.

A failure condition already true in the watch's first cycle is inherited, not
observed: it produces an `attention` record and does not raise exit `3`.
Restarting an observer over an execution you already know is dead therefore does
not report a fresh interruption; if nothing else is running, that Task is
settled and exits `4`. An `inactive` notice never ends a quiet watch unless you
pass `--wake-on-idle`: silence is not death, a long provider request or tool run
produces no usage, and inactivity is the one signal that cannot tell the two
apart. Settled can: nothing is executing at all.

## Auditing the quiet middle

Nothing about quiet mode hides progress; it only stops pushing it. When you or
the user want the middle, it is all on disk and costs nothing until read:

```bash
codeteam status <task-id>                     # agents, open Commitments, Task status
codeteam inspect <task-id> --commitment <id>  # Claim and its Receipt chain
codeteam usage <task-id>                      # attributed model calls
git -C <workspace> log --oneline              # the Workers' own commits
tail -f <run>/watch.ndjson                    # the full observation journal
```

`--since <seq>` replays durable events into a new watch; `last_seq` from a
previous `watch_result` is the cursor. `sub` remains a bounded historical read.

## Context pressure

Context pressure arrives as `type: "event"` with `event.kind: "context_pressure"`.
Its `context_pressure` object contains `basis: "pi_estimate"`, `utilization`,
`threshold`, `tokens`, and `context_window`. Utilization and threshold are ratios
(for example, `0.7` is 70%). Each execution emits only when reaching a higher
50%, 70%, or 80% level; a jump reports the highest reached level once. Unknown
estimates emit no signal. Use the event's Agent/execution identity to interpret
its scope, including events replayed by `--since`. The 80% event is persisted
before the existing budget interruption. Read pressure with the durable progress
reports to prepare the next assignment; observing it does not stop a Worker.

## Fallback: streaming into a host transport

Without `--quiet` the same watch prints every message and still ends with the
`watch_result` line. Use it for a live human reader, or for a host that cannot
hold a background process. Some host shell tools return a handle after a short
transport wait; that does not mean the watch timed out. Empty reads should stay
inside host-side code, not produce a fresh model decision to run `sub` or
inspect usage again. Surface nonempty updates, continue useful work, and reuse
the same handle.

For a host that exposes the `functions.exec` code orchestration tool and
`exec_command` / `write_stdin`, this is the consumption pattern. This snippet
runs inside that tool, not as a shell script. Fill in the verified absolute
workspace, runtime command, and Task id; do not create a new Task here.

```javascript
// @exec: {"yield_time_ms": 1000, "max_output_tokens": 2500}
let result = await tools.exec_command({
  cmd: "<absolute runtime/bin/codeteam> watch <task-id> --since <last-seq>",
  workdir: "<absolute target workspace>",
  tty: true,
  yield_time_ms: 1000,
  max_output_tokens: 2500
});
if (result.output.trim()) text(result.output);
if (result.session_id) {
  // Retain this handle for observation-only cancellation if needed.
  text({watch_session_id: result.session_id});
  await yield_control();
}
while (result.session_id) {
  result = await tools.write_stdin({
    session_id: result.session_id,
    chars: "",
    yield_time_ms: 45000,
    max_output_tokens: 2500
  });
  if (result.output.trim()) {
    text(result.output);
    await yield_control();
  }
  // Empty transport reads keep waiting here, without involving the model.
}
```

The host's code cell may itself yield a running-cell handle; keep that cell
instead of starting duplicate listeners. Its asynchronous transport and
notification behavior remain host capabilities, not guarantees of this CLI.
The example uses a PTY so Ctrl-C on the retained transport handle cancels only
the watch. Do not use `codeteam stop` to cancel observation, and do not assume
ending a host turn will stop either a detached Worker or its observer.

Report actual Claims, progress Receipts, corrections, verification and blockers.
Do not narrate an unchanged wait or repeat usage totals. An inactive notice
requests inspection: a long provider request or tool can still be running, and
neither new usage nor a live PID establishes a correct result.
