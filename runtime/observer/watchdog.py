#!/usr/bin/env python3
"""Liveness monitor for one codeflow agent process.

A plugin runs *inside* the process it would report on, so it dies with it: a
SIGKILLed or OOM-killed agent can never file its own exit receipt. This is a
separate, detached process, which is why it can.

It does two things and nothing else:

* refresh ``liveness/<pid>--<role>--<depth>.json`` while the monitored
  process lives, so ``codeflow agents list`` has a fact source; and
* record the exit once it happens, publishing ``runner_exited`` only for
  depth 0 — a depth-1 child's exit is already observed by its parent
  delegation, so publishing it would be noise.

Elapsed wall time is never treated as failure: the monitor waits for an
actual process exit and has no timeout of its own.
"""

import argparse
import contextlib
import io
import os
import select
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(
    0, str(Path(__file__).resolve().parents[2] / "write-handoff" / "scripts")
)
import handoff_state  # noqa: E402

DEFAULT_INTERVAL = 60.0
FALLBACK_POLL_INTERVAL = 2.0


def _now():
    return datetime.now(timezone.utc).isoformat()


def _proc_state(stat_text):
    """Return the kernel state char from a /proc/<pid>/stat body.

    ``comm`` is parenthesized and may itself contain spaces and parens, so
    the state field is parsed after the LAST ``)``. Returns None when the
    body cannot be parsed.
    """
    rparen = stat_text.rfind(")")
    if rparen < 0:
        return None
    tail = stat_text[rparen + 1:].split()
    return tail[0] if tail else None


def _alive(pid):
    # A zombie is dead even though os.kill(pid, 0) still succeeds for it:
    # the kernel keeps a zombie's entry until someone reaps it, and an
    # un-reaped depth-0 runner (e.g. adopted by a non-init PID 1) would
    # otherwise block the watchdog forever, stranding its runner_exited
    # stop signal and hanging the observe loop. Read the procfs state
    # first so a state-Z process counts as dead.
    stat_path = Path(f"/proc/{pid}/stat")
    if stat_path.is_file():
        try:
            state = _proc_state(stat_path.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            state = None
        if state == "Z":
            return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return Path(f"/proc/{pid}").exists()


class _ExitWaiter:
    """Wait for a pid to exit: pidfd where available, /proc polling otherwise."""

    def __init__(self, pid):
        self.pid = pid
        self._fd = None
        opener = getattr(os, "pidfd_open", None)
        if opener is not None:
            try:
                self._fd = opener(pid)
            except (OSError, ProcessLookupError):
                self._fd = None

    def wait(self, timeout):
        """Return True when the process has exited within *timeout* seconds."""
        if self._fd is not None:
            readable, _, _ = select.select([self._fd], [], [], timeout)
            return bool(readable)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not _alive(self.pid):
                return True
            time.sleep(min(FALLBACK_POLL_INTERVAL, max(0.01, deadline - time.monotonic())))
        return not _alive(self.pid)

    def close(self):
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None


def _heartbeat_path(paths, pid, role, depth):
    return paths.liveness / f"{pid}--{handoff_state.slug(role)}--{depth}.json"


def _write_heartbeat(paths, pid, role, depth, started_at):
    record = {
        "schema_version": handoff_state.SCHEMA_VERSION,
        "run_id": paths.run_id,
        "pid": pid,
        "role": role,
        "depth": depth,
        "status": "alive",
        "started_at": started_at,
        "heartbeat_at": _now(),
    }
    handoff_state.write_json_atomic(_heartbeat_path(paths, pid, role, depth), record)


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--role", required=True)
    parser.add_argument("--depth", type=int, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument(
        "--runs-dir", default=os.environ.get("CODEFLOW_RUNS_DIR", handoff_state.DEFAULT_RUNS_DIR)
    )
    parser.add_argument("--interval", type=float, default=DEFAULT_INTERVAL)
    args = parser.parse_args(argv)

    paths = handoff_state.RunPaths(args.runs_dir, args.run_id)
    started_at = _now()
    interval = max(0.05, args.interval)

    waiter = _ExitWaiter(args.pid)
    try:
        while True:
            if not _alive(args.pid):
                break
            _write_heartbeat(paths, args.pid, args.role, args.depth, started_at)
            if waiter.wait(interval):
                # A pidfd/proc wakeup must be reconfirmed against _alive: a
                # still-alive pid means a spurious wakeup (e.g. a pidfd race)
                # and the monitor must keep watching rather than emit a false
                # runner_exited stop signal for the observe loop.
                if not _alive(args.pid):
                    break
    finally:
        waiter.close()

    with contextlib.redirect_stdout(io.StringIO()):
        handoff_state.main(
            [
                "handoff", "runner-exited",
                "--run-id", args.run_id,
                "--runs-dir", str(args.runs_dir),
                "--pid", str(args.pid),
                "--role", args.role,
                "--depth", str(args.depth),
            ]
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
