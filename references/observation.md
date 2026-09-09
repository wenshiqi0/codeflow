# Persistent observation in an asynchronous host

`codeteam watch` owns the activity loop. Keep a single process and transport
handle for the Task, including idle periods between assignments. Its NDJSON
records carry caller-authored instructions and public events, never a Pi
transcript. Usage-only growth extends per-execution patience without producing
stdout. `attention` and `settled` are notifications, not process exit or Task
completion. Only Task finish or observer cancellation ends the stream.

Context pressure arrives as `type: "event"` with `event.kind: "context_pressure"`.
Its `context_pressure` object contains `basis: "pi_estimate"`, `utilization`,
`threshold`, `tokens`, and `context_window`. Utilization and threshold are ratios
(for example, `0.7` is 70%). Each execution emits only when reaching a higher
50%, 70%, or 80% level; a jump reports the highest reached level once. Unknown
estimates emit no signal. Use the event's Agent/execution identity to interpret
its scope, including events replayed by `--since`. The 80% event is persisted
before the existing budget interruption. Read pressure with the durable progress
reports to prepare the next assignment; observing it does not stop a Worker.

Some host shell tools return a handle after a short transport wait. That does
not mean the watch timed out. Empty reads should stay inside host-side code,
not produce a fresh model decision to run `sub` or inspect usage again. Surface
nonempty updates, continue useful work, and reuse the same handle.

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
