#!/usr/bin/env python3
"""Read-only CLI over the run fact ledger.

Writing goes through ``handoff finish`` only; this entry point exists so the
context extension can render the ledger without reimplementing supersede
resolution in TypeScript. Two implementations of the same format would drift.
"""

import argparse
import json
import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import facts  # noqa: E402

DEFAULT_RUNS_DIR = ".codeflow/runs/code"


def _ledger(args):
    return facts.ledger_path(Path(args.runs_dir) / args.run_id)


def cmd_render(args):
    rendered = facts.render(_ledger(args))
    if rendered:
        print(rendered)
    return 0


def cmd_list(args):
    print(json.dumps(facts.materialize(_ledger(args)), ensure_ascii=False, indent=2))
    return 0


def main(argv):
    parser = argparse.ArgumentParser(description="Read the codeflow run fact ledger")
    sub = parser.add_subparsers(dest="command", required=True)

    for name, handler in (("render", cmd_render), ("list", cmd_list)):
        entry = sub.add_parser(name)
        entry.add_argument("--run-id", default=os.environ.get("CODEFLOW_RUN_ID"))
        entry.add_argument(
            "--runs-dir", default=os.environ.get("CODEFLOW_RUNS_DIR", DEFAULT_RUNS_DIR)
        )
        entry.set_defaults(handler=handler)

    args = parser.parse_args(argv)
    if not args.run_id:
        print("codeflow facts: error: --run-id is required", file=sys.stderr)
        return 1
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
