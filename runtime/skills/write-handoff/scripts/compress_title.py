#!/usr/bin/env python3
"""Compress an oversized or missing handoff Goal into a registry title.

This is the fallback path, not the route: the ``write-handoff`` contract
already forces a one-line Goal, so a title normally costs nothing. It runs
only when that line is absent or over budget.

Three properties make it safe to invoke from the mechanical layer:

* it is spawned detached, so no state write ever waits on a model call;
* it writes exactly one file, ``title.txt``, and never touches state; and
* it is allowed to fail — writing nothing leaves the registry showing the
  truncated Goal, which is a worse title but never a wrong one.
"""

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

DEFAULT_BUDGET = 80
RUNTIME_DIR = Path(__file__).resolve().parents[3]
PI_RUNTIME = RUNTIME_DIR / "bin" / "pi-runtime"
AGENT = "title-compressor"

PROMPT = (
    "Summarize this delegation as one line of at most {budget} characters. "
    "Reply with the line only.\n\n{body}"
)


def _model_command(prompt):
    override = os.environ.get("CODEFLOW_TITLE_COMPRESS_CMD")
    if override:
        return shlex.split(override) + [prompt]
    return ["python3", str(PI_RUNTIME), "run", "--agent", AGENT, prompt]


def _final_assistant_text(stream):
    """Extract the last assistant text from pi's JSON event stream."""
    text = ""
    for line in stream.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict) or event.get("type") != "message_end":
            continue
        message = event.get("message") or {}
        if message.get("role") != "assistant":
            continue
        for part in message.get("content") or ():
            if isinstance(part, dict) and part.get("type") == "text":
                text = part.get("text") or text
    return text


def _one_line(text, budget):
    for line in text.splitlines():
        collapsed = re.sub(r"\s+", " ", line).strip()
        if collapsed:
            return collapsed[:budget]
    return ""


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--handoff-dir", required=True)
    parser.add_argument("--budget", type=int, default=DEFAULT_BUDGET)
    args = parser.parse_args(argv)

    directory = Path(args.handoff_dir)
    body_path = directory / "handoff.md"
    if not body_path.is_file():
        return 0

    prompt = PROMPT.format(budget=args.budget, body=body_path.read_text(encoding="utf-8"))
    try:
        completed = subprocess.run(
            _model_command(prompt),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return 0
    if completed.returncode != 0:
        return 0

    title = _one_line(_final_assistant_text(completed.stdout), args.budget)
    if not title:
        return 0

    staging = directory / ".title.txt.tmp"
    staging.write_text(title + "\n", encoding="utf-8")
    os.replace(staging, directory / "title.txt")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
