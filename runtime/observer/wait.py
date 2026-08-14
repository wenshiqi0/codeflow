#!/usr/bin/env python3
"""Block until a codeflow run delivers new events, then return the increment.

This replaces the old polling ladder. The observe loop makes one call and is
suspended until something happens or the timeout expires, so an unchanged
execute loop costs zero tokens and never disturbs the KV cache.

Only file *names* are parsed. The name carries sequence, subject, kind, and
status, which is everything needed to decide whether a body is worth
reading; bodies stay the exception.

On Linux the wait is an inotify watch for ``IN_MOVED_TO``: events are
delivered by renaming a fully written file into the watched directory, so a
completed rename is the only thing worth waking for. Where inotify is
unavailable (macOS, NFS) this falls back to a short internal stat poll. The
fallback changes nothing the caller can observe.
"""

import argparse
import ctypes
import json
import os
import re
import select
import sys
import time
from pathlib import Path

DEFAULT_RUNS_DIR = ".codeflow/runs/code"
DEFAULT_TIMEOUT = 600.0
POLL_INTERVAL = 0.25

EVENT_NAME = re.compile(
    r"^(?P<seq>\d{5})--(?P<subject>[a-z0-9-]+)--(?P<kind>[a-z_]+)--(?P<status>[A-Z_]+)\.json$"
)

IN_MOVED_TO = 0x00000080
IN_CREATE = 0x00000100
IN_NONBLOCK = 0x00000800
INOTIFY_HEADER_SIZE = 16


class _Inotify:
    """Minimal ctypes inotify watch; any failure degrades to stat polling."""

    def __init__(self, path):
        self._libc = ctypes.CDLL("libc.so.6", use_errno=True)
        self._fd = self._libc.inotify_init1(IN_NONBLOCK)
        if self._fd < 0:
            raise OSError(ctypes.get_errno(), "inotify_init1 failed")
        watch = self._libc.inotify_add_watch(
            self._fd, str(path).encode("utf-8"), IN_MOVED_TO | IN_CREATE
        )
        if watch < 0:
            errno = ctypes.get_errno()
            os.close(self._fd)
            raise OSError(errno, f"inotify_add_watch failed for {path}")

    def wait(self, timeout):
        """Return True when the directory changed within *timeout* seconds."""
        readable, _, _ = select.select([self._fd], [], [], timeout)
        if not readable:
            return False
        try:
            # Drain the queue: any notification means "rescan the directory",
            # so the individual records do not need to be interpreted.
            while True:
                if not os.read(self._fd, 4096):
                    break
                readable, _, _ = select.select([self._fd], [], [], 0)
                if not readable:
                    break
        except BlockingIOError:
            pass
        except OSError:
            pass
        return True

    def close(self):
        try:
            os.close(self._fd)
        except OSError:
            pass


def _scan(directory, since, kinds):
    """Return (matching events, water mark) parsed from file names only."""
    events = []
    water_mark = since
    if not directory.is_dir():
        return events, water_mark
    try:
        names = sorted(entry.name for entry in os.scandir(directory) if entry.is_file())
    except OSError:
        return events, water_mark
    for name in names:
        match = EVENT_NAME.match(name)
        if not match:
            continue
        seq = int(match.group("seq"))
        water_mark = max(water_mark, seq)
        if seq <= since:
            continue
        if kinds and match.group("kind") not in kinds:
            continue
        events.append(
            {
                "seq": seq,
                "subject": match.group("subject"),
                "kind": match.group("kind"),
                "status": match.group("status"),
                "file": name,
            }
        )
    events.sort(key=lambda event: event["seq"])
    return events, water_mark


def _watch_dir(runs_dir, run_id):
    """Named-run streams live in events/; discovery watches the shared spool."""
    base = Path(runs_dir)
    if run_id:
        return base / run_id / "events", "events"
    return base / "_spool", "_spool"


def _open_inotify(directory, backend):
    """Return a watcher, or None to fall back to stat polling.

    Observation is read-only, so a directory that does not exist yet is not
    created here — the loop polls until the execute loop makes it and attaches
    a watch then. Unavailability degrades instead of failing: the caller's
    contract is "one call, suspended until something happens", not "inotify".
    """
    if backend == "poll" or not directory.is_dir():
        return None
    try:
        return _Inotify(directory)
    except (OSError, AttributeError):
        return None


def main(argv):
    parser = argparse.ArgumentParser(
        description="Block until new codeflow events arrive, then return them"
    )
    parser.add_argument("--run-id")
    parser.add_argument(
        "--runs-dir", default=os.environ.get("CODEFLOW_RUNS_DIR", DEFAULT_RUNS_DIR)
    )
    parser.add_argument("--since", type=int, default=0)
    parser.add_argument("--kind", action="append", default=[])
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    args = parser.parse_args(argv)

    run_id = args.run_id or os.environ.get("CODEFLOW_RUN_ID") or None
    kinds = set()
    for entry in args.kind:
        kinds.update(token.strip() for token in entry.split(",") if token.strip())

    directory, prefix = _watch_dir(args.runs_dir, run_id)
    backend = os.environ.get("CODEFLOW_WAIT_BACKEND", "auto")

    events, water_mark = _scan(directory, args.since, kinds)
    if not events:
        watcher = _open_inotify(directory, backend)
        deadline = time.monotonic() + max(0.0, args.timeout)
        try:
            while not events and time.monotonic() < deadline:
                remaining = max(0.01, deadline - time.monotonic())
                if watcher is not None:
                    watcher.wait(remaining)
                else:
                    time.sleep(min(POLL_INTERVAL, remaining))
                    # The directory may have just been created by the inner
                    # loop; upgrade to a watch as soon as there is one.
                    watcher = _open_inotify(directory, backend)
                events, water_mark = _scan(directory, args.since, kinds)
        finally:
            if watcher is not None:
                watcher.close()

    for event in events:
        event["file"] = f"{prefix}/{event['file']}"

    print(
        json.dumps(
            {"run_id": run_id, "seq": water_mark, "events": events},
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
