#!/usr/bin/env python3
"""Cheap one-line diagnostic for a codeflow run.

This is a manual troubleshooting tool, not part of the observe-loop contract:
coordination observation is `codeflow wait`, which blocks instead of polling.

With no arguments it discovers the newest run below the runs directory by
directory mtime, then prints:
state=<alive|exited|unknown> activity=<Ns> fp=<handoff:status:size>.
Exit codes: 0 alive, 1 exited, 2 unknown.

Liveness comes from the process, never from a receipt's status: a terminal
handoff does not end the run. When the run recorded its depth-0 pid the
check is attributed to that pid, so concurrent runs cannot be confused for
one another; without it the process table is the last resort.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

STATUS_TOKENS = {"open": "OPEN", "running": "RUNNING", "blocked": "BLOCKED"}


def _process_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def _discover_run_id(runs_dir):
    base = Path(runs_dir)
    if not base.is_dir():
        return None
    candidates = [p for p in base.iterdir() if p.is_dir() and not p.name.startswith("_")]
    if not candidates:
        return None
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0].name


def _pi_running():
    override = os.environ.get("CODEFLOW_PROBE_PI_RUNNING")
    if override == "1":
        return True
    if override == "0":
        return False
    try:
        result = subprocess.run(
            ["ps", "-eo", "comm="],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    for line in result.stdout.decode("utf-8", "replace").splitlines():
        if line.strip() == "pi":
            return True
    return False


def _runner_pid(run_dir):
    path = run_dir / "runner.json"
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8")).get("pid")
    except (OSError, ValueError):
        return None
    return value if isinstance(value, int) else None


def _fingerprint_path(run_dir):
    """Prefer the newest in-flight handoff; otherwise the newest one at all."""
    active = run_dir / "active"
    if active.is_dir():
        names = sorted(entry.name for entry in active.iterdir() if entry.is_file())
        if names:
            candidate = run_dir / "handoffs" / names[-1] / "state.json"
            if candidate.is_file():
                return candidate
    handoffs = run_dir / "handoffs"
    if not handoffs.is_dir():
        return None
    states = [
        directory / "state.json"
        for directory in handoffs.iterdir()
        if (directory / "state.json").is_file()
    ]
    if not states:
        return None
    states.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return states[0]


def _status_token(data):
    status = data.get("status")
    if status == "done":
        return data.get("result") or "DONE"
    return STATUS_TOKENS.get(status, "?")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--runs-dir", default=".codeflow/runs/code")
    parser.add_argument("--pid", type=int)
    args = parser.parse_args()

    run_id = args.run_id
    if run_id is None:
        run_id = _discover_run_id(args.runs_dir)

    EXIT = {"alive": 0, "exited": 1, "unknown": 2}
    unknown = "state=unknown activity=- fp=-"

    if run_id is None:
        print(unknown)
        return EXIT["unknown"]

    run_dir = Path(args.runs_dir) / run_id
    fingerprint = _fingerprint_path(run_dir)
    if fingerprint is None:
        print(unknown)
        return EXIT["unknown"]
    try:
        data = json.loads(fingerprint.read_text(encoding="utf-8"))
        stat = fingerprint.stat()
    except (OSError, ValueError):
        print(unknown)
        return EXIT["unknown"]

    handoff = data.get("handoff_id", "?")
    activity = max(0, int(time.time() - stat.st_mtime))

    pid = args.pid if args.pid is not None else _runner_pid(run_dir)
    if pid is not None:
        state = "alive" if _process_alive(pid) else "exited"
    else:
        running = _pi_running()
        if running is True:
            state = "alive"
        elif running is False:
            state = "exited"
        else:
            state = "unknown"

    print(
        f"state={state} activity={activity}s "
        f"fp={handoff}:{_status_token(data)}:{stat.st_size}"
    )
    return EXIT[state]


if __name__ == "__main__":
    sys.exit(main())
