#!/usr/bin/env python3
"""Run-scoped shared fact ledger.

Isolating roles buys independence at a real cost: every fresh process
rediscovers what an earlier one already confirmed. The planner grep-walks
its way to ``src/router.ts:42``, then coder starts blank and walks the same
path again. This ledger carries those confirmed facts across the isolation
boundary without carrying the context that produced them.

It holds one flow's working consensus, not durable knowledge. Scope is the
run: a new plan starts a new ledger, and anything worth keeping crosses over
as prose in the planner's final report, never by inheriting this file.

Three properties make it trustworthy enough to read without re-verifying:

* **Only the CLI writes it.** Entries arrive through ``handoff finish``, so a
  fact is a side effect of a validated receipt. No model writes this file, in
  keeping with the rule that state is mechanical.
* **A claim must be checkable.** Every entry carries a locator — a real
  in-repo ``path``, a ``symbol``, or a literal ``value``. Paths are verified
  to exist at write time, because the CLI can do that mechanically. A claim
  with nowhere to check it is an opinion.
* **Corrections append.** A later role that finds a fact stale writes a
  ``supersede`` record pointing at the original id. History stays intact and
  the correction is attributable; readers see only the surviving view.
"""

import json
import os
from pathlib import Path

#: Locators, in the order rendered. ``path`` is verified; the others are
#: taken at face value because the CLI cannot check them.
LOCATOR_FIELDS = ("path", "symbol", "value")

ALLOWED_FIELDS = frozenset(
    {"claim", "path", "line", "symbol", "value", "supersedes", "reason"}
)

#: Caps on a single handoff's contribution. The ledger is only useful while
#: it stays readable; a role that needs more than this is describing its
#: process instead of naming facts.
MAX_FACTS_PER_HANDOFF = 12
MAX_CLAIM_CHARS = 200

LEDGER_NAME = "facts.jsonl"


class FactError(Exception):
    """A mechanical rejection: unverifiable claim, unknown field, bad target."""


def ledger_path(run_dir):
    """The ledger for one run. One flow, one file."""
    return Path(run_dir) / LEDGER_NAME


def _read_records(path):
    """Every record in order. A damaged line is skipped, never fatal: a
    partially readable ledger must degrade to fewer facts rather than break
    a run that would otherwise succeed."""
    path = Path(path)
    if not path.is_file():
        return []
    records = []
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return []
    for line in content.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict) and "id" in record:
            records.append(record)
    return records


def _verify_path(value):
    """Confirm a path locator names a real file inside the repository."""
    if not isinstance(value, str) or not value.strip():
        raise FactError("path must be a non-empty string")
    candidate = Path(value)
    if candidate.is_absolute():
        raise FactError(
            f"path must be repository-relative, got absolute path: {value}"
        )
    # Reject traversal before touching the filesystem: a fact about a file
    # outside the repository is not this run's business.
    if os.path.isabs(os.path.normpath(value)) or os.path.normpath(value).startswith(".."):
        raise FactError(f"path escapes the repository: {value}")
    if not candidate.exists():
        raise FactError(
            f"path does not exist: {value} (a fact must be checkable at the "
            "moment it is recorded)"
        )


def _validate(entry, index, known_ids):
    """Validate one entry and return its normalized form."""
    if not isinstance(entry, dict):
        raise FactError(f"fact {index} must be a JSON object")

    unknown = sorted(set(entry) - ALLOWED_FIELDS)
    if unknown:
        raise FactError(
            f"fact {index} has unknown field(s): {', '.join(unknown)}; "
            f"allowed: {', '.join(sorted(ALLOWED_FIELDS))}"
        )

    claim = entry.get("claim")
    if not isinstance(claim, str) or not claim.strip():
        raise FactError(f"fact {index} is missing a non-empty claim")
    claim = claim.strip()
    if len(claim) > MAX_CLAIM_CHARS:
        raise FactError(
            f"fact {index} claim exceeds {MAX_CLAIM_CHARS} characters; "
            "name the fact, do not narrate it"
        )

    present = [field for field in LOCATOR_FIELDS if entry.get(field) not in (None, "")]
    if not present:
        raise FactError(
            f"fact {index} needs a locator (one of {', '.join(LOCATOR_FIELDS)}); "
            "a claim nobody can check is an opinion, not a fact"
        )

    normalized = {"claim": claim}

    if "path" in entry and entry["path"] not in (None, ""):
        _verify_path(entry["path"])
        normalized["path"] = entry["path"]

    if "line" in entry and entry["line"] is not None:
        line = entry["line"]
        if isinstance(line, bool) or not isinstance(line, int) or line < 1:
            raise FactError(f"fact {index} line must be a positive integer")
        normalized["line"] = line

    for field in ("symbol", "value"):
        if entry.get(field) not in (None, ""):
            if not isinstance(entry[field], str):
                raise FactError(f"fact {index} {field} must be a string")
            normalized[field] = entry[field].strip()

    if entry.get("supersedes") not in (None, ""):
        target = entry["supersedes"]
        if target not in known_ids:
            raise FactError(
                f"fact {index} supersedes unknown fact id {target!r}; "
                "a correction must name the record it replaces"
            )
        normalized["supersedes"] = target
        if entry.get("reason") not in (None, ""):
            if not isinstance(entry["reason"], str):
                raise FactError(f"fact {index} reason must be a string")
            normalized["reason"] = entry["reason"].strip()
    elif entry.get("reason") not in (None, ""):
        raise FactError(
            f"fact {index} carries a reason without supersedes; a reason "
            "explains a correction"
        )

    return normalized


def append_facts(path, entries, role, handoff_id):
    """Append a validated batch, returning the records written.

    The whole batch is validated before anything is written, so a rejected
    entry cannot leave a half-applied batch on disk.
    """
    if not entries:
        return []
    if not isinstance(entries, list):
        raise FactError("facts must be a JSON array")
    if len(entries) > MAX_FACTS_PER_HANDOFF:
        raise FactError(
            f"a handoff may record at most {MAX_FACTS_PER_HANDOFF} facts, "
            f"got {len(entries)}; keep only what the next role needs"
        )

    path = Path(path)
    existing = _read_records(path)
    known_ids = {record["id"] for record in existing}
    next_index = len(existing) + 1

    staged = []
    for offset, entry in enumerate(entries):
        normalized = _validate(entry, offset, known_ids | {record["id"] for record in staged})
        record = {
            "id": f"f{next_index + offset}",
            "kind": "supersede" if "supersedes" in normalized else "fact",
            "role": role,
            "handoff_id": handoff_id,
        }
        record.update(normalized)
        staged.append(record)

    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as handle:
        for record in staged:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return staged


def materialize(path):
    """The surviving view: every record minus those a later one replaced."""
    records = _read_records(path)
    superseded = {
        record["supersedes"]
        for record in records
        if record.get("kind") == "supersede" and record.get("supersedes")
    }
    return [record for record in records if record["id"] not in superseded]


def _locator(record):
    if record.get("path"):
        return f"{record['path']}:{record['line']}" if record.get("line") else record["path"]
    if record.get("symbol"):
        return record["symbol"]
    return record.get("value", "")


def render(path):
    """Plain-text view for context injection. Empty when there is nothing."""
    view = materialize(path)
    if not view:
        return ""
    lines = []
    for record in view:
        locator = _locator(record)
        suffix = f" [{record['role']}]"
        lines.append(f"{record['id']}: {record['claim']} — {locator}{suffix}")
    return "\n".join(lines)
