#!/usr/bin/env python3
"""Mechanical state layer for codeflow handoffs.

A handoff is one unit of work moved from a delegator to a receiver. The
delegator writes the body (semantic plane); this CLI owns every state
change and every state query (mechanical plane):

  open -> running -> done(PASS|FAIL)
                  \\-> blocked(reason)

Nothing here decides what to delegate or interprets why something failed.
Conversely, no model may write ``state.json``, an event file, or a sentinel
by hand: state that depends on a model remembering to write it is a design
error, so every transition hangs on a CLI subcommand instead.

Layout below ``.codeflow/runs/code/``::

    _spool/                       run-level discovery point (cross-run)
    <run-id>/
      handoffs/<handoff-id>/      handoff.md, state.json, receipt.json, title.txt
      active/<handoff-id>         sentinel: one file per in-flight handoff
      events/<seq>--<subject>--<kind>--<status>.json
      tmp/                        staging; rename into events/ delivers
      liveness/<pid>--<role>--<depth>.json
      runner.json                 depth-0 pid and startup info
"""

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import facts

SCHEMA_VERSION = 2

#: The single top-level blocked enum. The CLI and the policy layer share it
#: so a required reason can never be demoted into free-text prose.
BLOCKED_REASONS = (
    "CONTEXT_BUDGET_EXCEEDED",
    "DELEGATION_ARTIFACT_MISSING",
    "OUTPUT_TRUNCATED",
    "PROVIDER_FAILURE",
    "USER_CANCELLED",
)

#: Reasons that carry the nested budget detail structure.
BUDGET_REASONS = ("CONTEXT_BUDGET_EXCEEDED",)

EVENT_KINDS = (
    "run_started",
    "run_finished",
    "handoff_opened",
    "handoff_finished",
    "artifact_written",
    "runner_exited",
)

TERMINAL_STATUSES = ("PASS", "FAIL", "BLOCKED")

#: An excerpt longer than this is spilled to evidence/ and replaced by a ref.
ERROR_EXCERPT_LIMIT = 2000

#: Registry titles are one line; a longer Goal triggers async compression.
TITLE_BUDGET = 80

#: Keep event file names inside the 255-byte limit every target filesystem has.
MAX_NAME_BYTES = 255
MAX_SUBJECT_CHARS = 120

DEFAULT_RUNS_DIR = ".codeflow/runs/code"
DEFAULT_STALE_SECONDS = 600

RECEIPT_REQUIRED_BY_ROLE = {
    "test-runner": ("status", "command", "exit_code"),
}
RECEIPT_REQUIRED_BASE = ("status",)

GOAL_PATTERN = re.compile(r"^\s*(?:[-*]\s*)?(?:#+\s*)?Goal\s*:\s*(.+?)\s*$", re.IGNORECASE)
GOAL_HEADING = re.compile(r"^\s*#+\s*Goal\s*$", re.IGNORECASE)
SCOPE_PATTERN = re.compile(r"^\s*(?:[-*]\s*)?(?:#+\s*)?Scope\s*:\s*(.+?)\s*$", re.IGNORECASE)


class CliError(Exception):
    """A mechanical rejection: illegal transition, bad schema, missing fact."""


def _now():
    return datetime.now(timezone.utc).isoformat()


def slug(value):
    cleaned = re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-")
    return cleaned or "unnamed"


def write_json_atomic(path, value):
    """Write via a per-process staging file so a reader never sees a partial."""
    path.parent.mkdir(parents=True, exist_ok=True)
    staging = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    staging.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(staging, path)


def _read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _next_seq(counter_path):
    """Allocate the next monotonic sequence number under an exclusive lock."""
    counter_path.parent.mkdir(parents=True, exist_ok=True)
    with open(counter_path, "a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            handle.seek(0)
            raw = handle.read().strip()
            value = int(raw) + 1 if raw.isdigit() else 1
            handle.seek(0)
            handle.truncate()
            handle.write(str(value))
            handle.flush()
            os.fsync(handle.fileno())
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    return value


class RunPaths:
    """Resolved filesystem facts for one run."""

    def __init__(self, runs_dir, run_id):
        self.code = Path(runs_dir)
        self.runs_root = self.code.parent
        self.run_id = run_id
        self.spool = self.code / "_spool"

    @property
    def run_dir(self):
        return self.code / self.run_id

    @property
    def handoffs(self):
        return self.run_dir / "handoffs"

    @property
    def active(self):
        return self.run_dir / "active"

    @property
    def events(self):
        return self.run_dir / "events"

    @property
    def tmp(self):
        return self.run_dir / "tmp"

    @property
    def liveness(self):
        return self.run_dir / "liveness"

    @property
    def evidence(self):
        return self.runs_root / "evidence" / self.run_id

    def handoff_dir(self, handoff_id):
        return self.handoffs / handoff_id

    def state_path(self, handoff_id):
        return self.handoff_dir(handoff_id) / "state.json"


def _event_name(seq, subject, kind, status):
    subject = slug(subject)[:MAX_SUBJECT_CHARS]
    name = f"{seq:05d}--{subject}--{kind}--{status}.json"
    overflow = len(name.encode("utf-8")) - MAX_NAME_BYTES
    if overflow > 0:
        subject = subject[: max(1, len(subject) - overflow)]
        name = f"{seq:05d}--{subject}--{kind}--{status}.json"
    return name


def _deliver_event(staging_dir, target_dir, counter_path, subject, kind, status, payload):
    """Write into a staging directory, then rename into the watched directory.

    The rename is atomic on one filesystem, so a listener never observes a
    half-written event and can react to ``IN_MOVED_TO`` alone.
    """
    if kind not in EVENT_KINDS:
        raise CliError(f"unknown event kind: {kind}")
    staging_dir.mkdir(parents=True, exist_ok=True)
    target_dir.mkdir(parents=True, exist_ok=True)
    seq = _next_seq(counter_path)
    name = _event_name(seq, subject, kind, status)
    body = {
        "schema_version": 1,
        "seq": seq,
        "kind": kind,
        "status": status,
        "subject": subject,
        "at": _now(),
    }
    body.update(payload)
    staging_path = staging_dir / name
    staging_path.write_text(
        json.dumps(body, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    os.replace(staging_path, target_dir / name)
    return {"seq": seq, "file": name}


def _emit_run_event(paths, kind, status, payload):
    """Run-level events land in this run's stream and in the global spool."""
    _deliver_event(
        paths.tmp,
        paths.events,
        paths.run_dir / ".events.seq",
        paths.run_id,
        kind,
        status,
        payload,
    )
    return _deliver_event(
        paths.spool / "tmp",
        paths.spool,
        paths.spool / ".events.seq",
        paths.run_id,
        kind,
        status,
        {**payload, "run_id": paths.run_id},
    )


def _emit_handoff_event(paths, handoff_id, kind, status, payload):
    return _deliver_event(
        paths.tmp,
        paths.events,
        paths.run_dir / ".events.seq",
        handoff_id,
        kind,
        status,
        {**payload, "run_id": paths.run_id},
    )


def _parse_goal(body):
    lines = body.splitlines()
    for index, line in enumerate(lines):
        match = GOAL_PATTERN.match(line)
        if match:
            return match.group(1).strip()
        if GOAL_HEADING.match(line):
            for follow in lines[index + 1:]:
                if follow.strip():
                    return follow.strip().lstrip("-*").strip()
    return ""


def _parse_scope(body):
    scope = []
    for line in body.splitlines():
        match = SCOPE_PATTERN.match(line)
        if not match:
            continue
        for token in re.split(r"[,\s]+", match.group(1)):
            # Trailing punctuation is prose; a leading dot is part of the path.
            token = token.strip().strip("`\"'()[]").rstrip(".,;:")
            if not token:
                continue
            if "/" in token or "." in token:
                scope.append(token)
        break
    return scope


def _load_states(paths, only_active=False):
    if only_active:
        if not paths.active.is_dir():
            return []
        ids = sorted(p.name for p in paths.active.iterdir())
    else:
        if not paths.handoffs.is_dir():
            return []
        ids = sorted(p.name for p in paths.handoffs.iterdir() if p.is_dir())
    states = []
    for handoff_id in ids:
        path = paths.state_path(handoff_id)
        if path.is_file():
            try:
                states.append(_read_json(path))
            except ValueError:
                continue
    return states


def _title_for(paths, state):
    handoff_id = state["handoff_id"]
    compressed = paths.handoff_dir(handoff_id) / "title.txt"
    if compressed.is_file():
        text = compressed.read_text(encoding="utf-8").strip().splitlines()
        if text and text[0].strip():
            return text[0].strip()[:TITLE_BUDGET]
    goal = state.get("goal") or ""
    if len(goal) > TITLE_BUDGET:
        return goal[: TITLE_BUDGET - 1].rstrip() + "\u2026"
    return goal


def _stale_seconds():
    raw = os.environ.get("CODEFLOW_HANDOFF_TIMEOUT_SECONDS") or os.environ.get(
        "CODEFLOW_PHASE_TIMEOUT_SECONDS"
    )
    try:
        return int(raw) if raw else DEFAULT_STALE_SECONDS
    except ValueError:
        return DEFAULT_STALE_SECONDS


def _decorate_age(state):
    started = state.get("started_at") or state.get("opened_at")
    if state.get("status") not in ("open", "running") or not started:
        return state
    try:
        age = int((datetime.now(timezone.utc) - datetime.fromisoformat(started)).total_seconds())
    except ValueError:
        return state
    state["age_seconds"] = max(0, age)
    state["stale"] = state["age_seconds"] > _stale_seconds()
    return state


def _spawn_title_compression(paths, handoff_id):
    """Ask the cheap model for a title without ever blocking a state write.

    Detached, best-effort, and allowed to fail: while ``title.txt`` is absent
    the registry degrades to the truncated Goal. The mechanical plane must
    never wait on the semantic plane.
    """
    script = Path(__file__).resolve().parent / "compress_title.py"
    if not script.is_file():
        return
    try:
        subprocess.Popen(
            [
                sys.executable,
                str(script),
                "--handoff-dir",
                str(paths.handoff_dir(handoff_id)),
                "--budget",
                str(TITLE_BUDGET),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
    except OSError:
        return


def cmd_handoff_open(args, paths):
    body = _read_body(args)
    if not body.strip():
        raise CliError(
            "a handoff needs a body: pass --body-file <path> or --body-file - "
            "with the write-handoff structure on stdin"
        )

    goal = _parse_goal(body)
    scope = list(args.scope) if args.scope else _parse_scope(body)
    depth = args.depth
    if depth is None:
        depth = 1 if args.parent_id else 0

    existing_scope = {}
    for state in _load_states(paths, only_active=True):
        for entry in state.get("scope", []):
            existing_scope.setdefault(entry, state["handoff_id"])
    conflicts = sorted(entry for entry in scope if entry in existing_scope)

    seq = _next_seq(paths.run_dir / ".handoffs.seq")
    handoff_id = f"h{seq:05d}-{slug(args.role)}"[:MAX_SUBJECT_CHARS]
    directory = paths.handoff_dir(handoff_id)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "handoff.md").write_text(body, encoding="utf-8")

    state = {
        "schema_version": SCHEMA_VERSION,
        "run_id": paths.run_id,
        "handoff_id": handoff_id,
        "role": args.role,
        "depth": depth,
        "status": "open",
        "goal": goal,
        "scope": scope,
        "lineage": {
            "parent_handoff_id": args.parent_id,
            "parent_run_id": args.parent_run_id or (paths.run_id if args.parent_id else None),
            "split_scope": args.split_scope,
        },
        "opened_at": _now(),
        "scope_conflicts": conflicts,
    }
    write_json_atomic(paths.state_path(handoff_id), state)

    paths.active.mkdir(parents=True, exist_ok=True)
    (paths.active / handoff_id).write_text("", encoding="utf-8")

    if args.title:
        (directory / "title.txt").write_text(
            args.title.strip()[:TITLE_BUDGET] + "\n", encoding="utf-8"
        )
    elif not goal or len(goal) > TITLE_BUDGET:
        _spawn_title_compression(paths, handoff_id)

    _emit_handoff_event(
        paths,
        handoff_id,
        "handoff_opened",
        "OPEN",
        {"role": args.role, "depth": depth, "ref": f"handoffs/{handoff_id}/state.json"},
    )

    if conflicts:
        print(
            "warning: scope overlaps an active handoff: "
            + ", ".join(f"{entry} (held by {existing_scope[entry]})" for entry in conflicts),
            file=sys.stderr,
        )

    print(
        json.dumps(
            {
                "run_id": paths.run_id,
                "handoff_id": handoff_id,
                "role": args.role,
                "depth": depth,
                "status": "open",
                "dir": str(directory),
                "handoff_md": str(directory / "handoff.md"),
                "state": str(paths.state_path(handoff_id)),
                "receipt": str(directory / "receipt.json"),
                "scope": scope,
                "scope_conflicts": conflicts,
            },
            ensure_ascii=False,
        )
    )
    return 0


def _read_body(args):
    if args.body_file == "-":
        return sys.stdin.read()
    if args.body_file:
        path = Path(args.body_file)
        if not path.is_file():
            raise CliError(f"handoff body not found: {path}")
        return path.read_text(encoding="utf-8")
    return ""


def _require_state(paths, handoff_id):
    path = paths.state_path(handoff_id)
    if not path.is_file():
        raise CliError(f"unknown handoff: {handoff_id} (no {path})")
    return _read_json(path)


def cmd_handoff_start(args, paths):
    handoff_id = _resolve_handoff_id(args)
    state = _require_state(paths, handoff_id)
    if state["status"] in ("done", "blocked"):
        raise CliError(
            f"handoff {handoff_id} is already {state['status']}; "
            "starting a terminal handoff is an illegal transition"
        )
    if state["status"] != "running":
        state["status"] = "running"
        state["started_at"] = _now()
    if args.pid is not None:
        state["pid"] = args.pid
    write_json_atomic(paths.state_path(handoff_id), state)
    print(json.dumps({"handoff_id": handoff_id, "status": "running"}, ensure_ascii=False))
    return 0


RECEIPT_FIELD_TYPES = {
    "next_owner": str,
    "error_excerpt": str,
    "diagnosis": str,
    "command": str,
    "reproduction": str,
    "failed_checks": list,
    "exit_code": int,
    "expected_red": bool,
    "facts": list,
}


def _validate_receipt_entry(entry, role, index, paths, handoff_id, spills):
    if not isinstance(entry, dict):
        raise CliError(f"receipt entry {index} must be a JSON object")
    required = RECEIPT_REQUIRED_BY_ROLE.get(role, RECEIPT_REQUIRED_BASE)
    missing = [field for field in required if field not in entry]
    if missing:
        raise CliError(
            f"receipt entry {index} for role {role} is missing required "
            f"field(s): {', '.join(missing)}"
        )
    if entry["status"] not in TERMINAL_STATUSES:
        raise CliError(
            f"receipt entry {index} status must be one of "
            f"{', '.join(TERMINAL_STATUSES)}, got {entry['status']!r}"
        )
    for field, expected in RECEIPT_FIELD_TYPES.items():
        if field in entry and not isinstance(entry[field], expected):
            raise CliError(
                f"receipt entry {index} field {field} must be "
                f"{expected.__name__}, got {type(entry[field]).__name__}"
            )
    excerpt = entry.get("error_excerpt")
    if isinstance(excerpt, str) and len(excerpt) > ERROR_EXCERPT_LIMIT:
        relative = f"evidence/{paths.run_id}/{handoff_id}-{index}-error.txt"
        target = paths.runs_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(excerpt, encoding="utf-8")
        entry["error_excerpt"] = excerpt[: ERROR_EXCERPT_LIMIT - 1] + "\u2026"
        entry["error_excerpt_ref"] = relative
        spills.append(relative)
    return entry


def _validate_receipt(path, role, status, paths, handoff_id):
    if not path.is_file():
        raise CliError(f"receipt file not found: {path}")
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as error:
        raise CliError(f"receipt is not valid JSON ({error}); prose is not a receipt")
    if not isinstance(receipt, dict):
        raise CliError("receipt must be a JSON object")
    if "status" not in receipt:
        raise CliError("receipt is missing required field: status")
    if receipt["status"] != status:
        raise CliError(
            f"receipt status {receipt['status']!r} contradicts the declared "
            f"handoff status {status!r}"
        )
    spills = []
    entries = receipt.get("receipts")
    if isinstance(entries, list):
        if not entries:
            raise CliError("a batch receipt must contain at least one entry")
        receipt["receipts"] = [
            _validate_receipt_entry(entry, role, index, paths, handoff_id, spills)
            for index, entry in enumerate(entries)
        ]
    else:
        receipt = _validate_receipt_entry(receipt, role, 0, paths, handoff_id, spills)
    return receipt, spills


def cmd_handoff_finish(args, paths):
    handoff_id = _resolve_handoff_id(args)
    state = _require_state(paths, handoff_id)
    if state["status"] in ("done", "blocked"):
        raise CliError(
            f"handoff {handoff_id} is already {state['status']}; a terminal "
            "receipt is immutable"
        )
    if args.status == "BLOCKED" and not args.blocked_reason:
        raise CliError(
            "BLOCKED requires at least one --blocked-reason from: "
            + ", ".join(BLOCKED_REASONS)
        )
    if args.status != "BLOCKED" and args.blocked_reason:
        raise CliError("--blocked-reason is only valid with --status BLOCKED")
    # A delegated handoff reports through a validated artifact, never through
    # prose. BLOCKED is exempt: the reason enum is the receipt.
    if args.status != "BLOCKED" and not args.receipt and state.get("depth", 0) > 0:
        raise CliError(
            f"--receipt is required to finish delegated handoff {handoff_id} "
            f"as {args.status}"
        )

    artifacts = []
    for entry in args.artifact or ():
        path = Path(entry)
        if not path.is_file():
            raise CliError(f"declared artifact does not exist: {entry}")
        artifacts.append(entry)

    receipt = None
    spills = []
    recorded_facts = []
    if args.receipt:
        receipt, spills = _validate_receipt(
            Path(args.receipt), state["role"], args.status, paths, handoff_id
        )
        # Shared facts are a side effect of a validated receipt, never a
        # separate model-driven write. Validation runs before the state
        # transition so an unverifiable claim fails the finish loudly rather
        # than leaving a ledger nobody can trust.
        try:
            recorded_facts = facts.append_facts(
                facts.ledger_path(paths.run_dir),
                receipt.get("facts", []),
                role=state["role"],
                handoff_id=handoff_id,
            )
        except facts.FactError as error:
            raise CliError(f"receipt facts rejected: {error}")

    if receipt is not None:
        write_json_atomic(paths.handoff_dir(handoff_id) / "receipt.json", receipt)

    state["summary"] = args.summary
    state["finished_at"] = _now()
    if args.status == "BLOCKED":
        blocked = {
            "reason": args.blocked_reason[0],
            "reasons": list(args.blocked_reason),
        }
        if args.detail:
            blocked["detail"] = args.detail
        if any(reason in BUDGET_REASONS for reason in args.blocked_reason):
            blocked["budget_failure"] = build_budget_failure(args)
        state["status"] = "blocked"
        state["blocked"] = blocked
    else:
        state["status"] = "done"
        state["result"] = args.status
    if receipt is not None:
        state["receipt"] = f"handoffs/{handoff_id}/receipt.json"
    if spills:
        state["evidence_refs"] = spills
    if artifacts:
        state["artifacts"] = artifacts
    write_json_atomic(paths.state_path(handoff_id), state)

    sentinel = paths.active / handoff_id
    if sentinel.exists():
        sentinel.unlink()

    for artifact in artifacts:
        _emit_handoff_event(
            paths, handoff_id, "artifact_written", "WRITTEN", {"ref": artifact}
        )

    payload = {"ref": f"handoffs/{handoff_id}/state.json", "role": state["role"]}
    if receipt is not None:
        payload["receipt_ref"] = f"handoffs/{handoff_id}/receipt.json"
    if args.status == "BLOCKED":
        payload["reasons"] = list(args.blocked_reason)
    _emit_handoff_event(paths, handoff_id, "handoff_finished", args.status, payload)

    if not state["lineage"].get("parent_handoff_id"):
        _emit_run_event(
            paths,
            "run_finished",
            args.status,
            {"ref": f"handoffs/{handoff_id}/state.json", "handoff_id": handoff_id},
        )

    print(
        json.dumps(
            {
                "run_id": paths.run_id,
                "handoff_id": handoff_id,
                "status": args.status,
                "state": str(paths.state_path(handoff_id)),
                "receipt": (
                    str(paths.handoff_dir(handoff_id) / "receipt.json")
                    if receipt is not None
                    else None
                ),
                "facts_recorded": [record["id"] for record in recorded_facts],
            },
            ensure_ascii=False,
        )
    )
    return 0


def build_budget_failure(args):
    """Budget detail kept as a nested structure under the unified reason."""
    return {
        "budget": {
            "limit": args.budget_limit,
            "used": args.budget_used,
            "remaining": args.budget_remaining,
        },
        "protected_component": args.protected_component,
        "required_action": args.required_action,
        "largest_sources": json.loads(args.largest_sources),
        "source_refs": json.loads(args.source_refs),
    }


def cmd_handoff_status(args, paths):
    handoff_id = args.id or os.environ.get("CODEFLOW_HANDOFF_ID")
    if handoff_id:
        state = _decorate_age(_require_state(paths, handoff_id))
        print(json.dumps(state, ensure_ascii=False, indent=2))
        return 0
    active = [_decorate_age(state) for state in _load_states(paths, only_active=True)]
    print(json.dumps(active, ensure_ascii=False, indent=2))
    return 0


def cmd_handoff_list(args, paths):
    rows = []
    for state in _load_states(paths, only_active=args.active):
        rows.append(
            {
                "handoff_id": state["handoff_id"],
                "role": state.get("role"),
                "depth": state.get("depth"),
                "status": state.get("status"),
                "result": state.get("result") or (state.get("blocked") or {}).get("reason"),
                "title": _title_for(paths, state),
                "scope": state.get("scope", []),
            }
        )
    print(json.dumps(rows, ensure_ascii=False, indent=2))
    return 0


def cmd_handoff_run_start(args, paths):
    runner = {
        "schema_version": SCHEMA_VERSION,
        "run_id": paths.run_id,
        "role": args.role,
        "pid": args.pid,
        "started_at": _now(),
    }
    write_json_atomic(paths.run_dir / "runner.json", runner)
    _emit_run_event(paths, "run_started", "STARTED", {"ref": "runner.json", "role": args.role})
    print(json.dumps({"run_id": paths.run_id, "runner": str(paths.run_dir / "runner.json")}))
    return 0


def cmd_handoff_runner_exited(args, paths):
    """Record a monitored process exit; only depth 0 reaches the event stream.

    A depth-1 child's exit is already observed by the parent delegation, so
    publishing it would be noise. A depth-0 exit is different: nobody else
    is left to report that the execute loop stopped.
    """
    record = {
        "schema_version": SCHEMA_VERSION,
        "run_id": paths.run_id,
        "pid": args.pid,
        "role": args.role,
        "depth": args.depth,
        "status": "exited",
        "exited_at": _now(),
    }
    write_json_atomic(
        paths.liveness / f"{args.pid}--{slug(args.role)}--{args.depth}.json", record
    )
    emitted = None
    if args.depth == 0:
        emitted = _emit_run_event(
            paths,
            "runner_exited",
            "EXITED",
            {"pid": args.pid, "role": args.role, "ref": "runner.json"},
        )
    print(
        json.dumps(
            {"run_id": paths.run_id, "pid": args.pid, "depth": args.depth, "event": emitted},
            ensure_ascii=False,
        )
    )
    return 0


def cmd_agents_list(args, paths):
    """Derive the coordination board from three existing fact sources.

    liveness/ (watchdog-maintained) x active/ (in-flight handoffs) x
    handoffs/<id>/ (title and scope). Nothing has to remember to update a
    registry, so the view can never fall out of sync — and it is pull-only,
    never injected into an agent's context by the turn.
    """
    now = time.time()
    heartbeats = {}
    if paths.liveness.is_dir():
        for path in sorted(paths.liveness.glob("*.json")):
            try:
                record = _read_json(path)
            except ValueError:
                continue
            heartbeats[record.get("pid")] = record

    rows = []
    claimed = set()
    for state in _load_states(paths, only_active=True):
        pid = state.get("pid")
        record = heartbeats.get(pid) if pid is not None else None
        if record is not None:
            claimed.add(pid)
        rows.append(_registry_row(paths, state, record, now))

    for pid, record in heartbeats.items():
        if pid in claimed or record.get("status") == "exited":
            continue
        rows.append(
            {
                "role": record.get("role"),
                "depth": record.get("depth"),
                "pid": pid,
                "heartbeat_age_seconds": _heartbeat_age(record, now),
                "handoff_id": None,
                "title": "",
                "scope": [],
                "status": record.get("status", "alive"),
            }
        )

    rows.sort(key=lambda row: (row["depth"] or 0, row["role"] or "", row["handoff_id"] or ""))
    if args.format == "json":
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        for row in rows:
            print(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
    return 0


def _heartbeat_age(record, now):
    stamp = record.get("heartbeat_at") or record.get("started_at")
    if not stamp:
        return None
    try:
        beat = datetime.fromisoformat(stamp).timestamp()
    except ValueError:
        return None
    return max(0, int(now - beat))


def _registry_row(paths, state, record, now):
    return {
        "role": state.get("role"),
        "depth": state.get("depth"),
        "pid": state.get("pid"),
        "heartbeat_age_seconds": _heartbeat_age(record, now) if record else None,
        "handoff_id": state["handoff_id"],
        "title": _title_for(paths, state),
        "scope": state.get("scope", []),
        "status": state.get("status"),
    }


def _resolve_handoff_id(args):
    handoff_id = args.id or os.environ.get("CODEFLOW_HANDOFF_ID")
    if not handoff_id:
        raise CliError("--id is required (or set CODEFLOW_HANDOFF_ID)")
    return handoff_id


def _resolve_run_id(args):
    run_id = args.run_id or os.environ.get("CODEFLOW_RUN_ID")
    if not run_id:
        raise CliError(
            "--run-id is required (or set CODEFLOW_RUN_ID; `codeflow run` "
            "allocates and exports it)"
        )
    return run_id


def _add_common(parser):
    parser.add_argument("--run-id")
    parser.add_argument(
        "--runs-dir",
        default=os.environ.get("CODEFLOW_RUNS_DIR", DEFAULT_RUNS_DIR),
    )


def build_parser():
    parser = argparse.ArgumentParser(
        description="Record and inspect codeflow handoff state mechanically"
    )
    groups = parser.add_subparsers(dest="group", required=True)

    handoff = groups.add_parser("handoff", help="handoff lifecycle and queries")
    sub = handoff.add_subparsers(dest="command", required=True)

    opener = sub.add_parser("open", help="register a new handoff from its body")
    _add_common(opener)
    opener.add_argument("--role", required=True)
    opener.add_argument("--body-file", help="path to the handoff body, or - for stdin")
    opener.add_argument("--parent-id")
    opener.add_argument("--parent-run-id")
    opener.add_argument("--split-scope")
    opener.add_argument("--depth", type=int)
    opener.add_argument("--title")
    opener.add_argument("--scope", action="append")
    opener.set_defaults(handler=cmd_handoff_open)

    starter = sub.add_parser("start", help="mark a handoff as running")
    _add_common(starter)
    starter.add_argument("--id")
    starter.add_argument("--pid", type=int)
    starter.set_defaults(handler=cmd_handoff_start)

    finisher = sub.add_parser("finish", help="record a terminal handoff receipt")
    _add_common(finisher)
    finisher.add_argument("--id")
    finisher.add_argument("--status", required=True, choices=TERMINAL_STATUSES)
    finisher.add_argument("--summary", required=True)
    finisher.add_argument("--receipt")
    finisher.add_argument("--artifact", action="append")
    finisher.add_argument("--detail")
    finisher.add_argument("--blocked-reason", action="append", choices=BLOCKED_REASONS)
    finisher.add_argument("--budget-limit", type=int)
    finisher.add_argument("--budget-used", type=int)
    finisher.add_argument("--budget-remaining", type=int)
    finisher.add_argument("--protected-component")
    finisher.add_argument("--required-action")
    finisher.add_argument("--largest-sources", default="[]")
    finisher.add_argument("--source-refs", default="[]")
    finisher.set_defaults(handler=cmd_handoff_finish)

    status = sub.add_parser("status", help="one receipt, or every active handoff")
    _add_common(status)
    status.add_argument("--id")
    status.set_defaults(handler=cmd_handoff_status)

    listing = sub.add_parser("list", help="compact handoff rows")
    _add_common(listing)
    listing.add_argument("--active", action="store_true")
    listing.set_defaults(handler=cmd_handoff_list)

    run_start = sub.add_parser("run-start", help="record depth-0 startup")
    _add_common(run_start)
    run_start.add_argument("--role", required=True)
    run_start.add_argument("--pid", type=int, required=True)
    run_start.set_defaults(handler=cmd_handoff_run_start)

    exited = sub.add_parser("runner-exited", help="record a monitored process exit")
    _add_common(exited)
    exited.add_argument("--pid", type=int, required=True)
    exited.add_argument("--role", required=True)
    exited.add_argument("--depth", type=int, required=True)
    exited.set_defaults(handler=cmd_handoff_runner_exited)

    agents = groups.add_parser("agents", help="derived agent registry view")
    agents_sub = agents.add_subparsers(dest="command", required=True)
    agents_list = agents_sub.add_parser("list", help="who is doing what right now")
    _add_common(agents_list)
    agents_list.add_argument("--format", default="lines", choices=("lines", "json"))
    agents_list.set_defaults(handler=cmd_agents_list)

    return parser


def main(argv):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        paths = RunPaths(args.runs_dir, _resolve_run_id(args))
        return args.handler(args, paths)
    except CliError as error:
        print(f"codeflow handoff: error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
