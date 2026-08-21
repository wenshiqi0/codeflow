"""
Offline stand-in for the OFFICIAL SWE-bench evaluation harness, pinned to
SWE-bench/SWE-bench commit 7a21e05772954cc81471ae19d56f436cecf43c54.

This file is never executed directly and never talks to Docker or the network.
`tests/benchmark/fakes/pinned-harness-python3` (a PATH-injected `python3`
stand-in) runs it with a REAL local python3 when the wrapper invokes

    python3 -m swebench.harness.run_evaluation <flags>

It reproduces only the pinned commit's OBSERVABLE contract — the CLI surface,
the predictions field requirements, the report location, and the report
shape — so the wrapper (`benchmark/scripts/swebench-harness.sh`) can
be tested offline against what that exact commit actually does.

Ground truth (SWE-bench/SWE-bench @ 7a21e05772954cc81471ae19d56f436cecf43c54):

- swebench/harness/run_evaluation.py, `if __name__ == "__main__":` argparse:
  -d/--dataset_name (default "SWE-bench/SWE-bench_Lite"), -s/--split
  (default "test"), -i/--instance_ids (nargs "+"), -p/--predictions_path
  (required), --max_workers (int), --open_file_limit (int), -t/--timeout
  (int), -id/--run_id (required), --rewrite_reports, --report_dir,
  --modal. Unknown flags are argparse errors (exit 2).
- swebench/harness/run_evaluation.py, run_instance():
    model_name_or_path = pred.get("model_name_or_path", "None").replace("/", "__")
    log_dir = RUN_EVALUATION_LOG_DIR / run_id / model_name_or_path / instance_id
    report_path = log_dir / LOG_REPORT        # per-instance report.json
  RUN_EVALUATION_LOG_DIR is cwd-relative.
- swebench/harness/constants/__init__.py:
    RUN_EVALUATION_LOG_DIR = Path("logs/run_evaluation"); LOG_REPORT = "report.json".
- swebench/harness/grading.py get_eval_report(): the per-instance report is a
  dict keyed by instance_id whose value carries at least
  patch_is_None / patch_exists / patch_successfully_applied / resolved /
  infra_failure. (include_tests_status=True may add a "tests_status" detail;
  it is irrelevant to the wrapper's verdict.) NOTE: the `resolved_ids` /
  `unresolved_ids` key sets belong to a DIFFERENT artifact — the RUN-level
  report make_run_report() writes to <report_dir>/<model>.<run_id>.json —
  never to the per-instance report.json.
- swebench/harness/utils.py get_predictions_from_file(): predictions are
  JSONL; each line must be a dict containing "instance_id" (ValueError
  otherwise). get_dataset_from_preds() raises KeyError on a missing
  model_name_or_path (pre-run, non-zero exit); a missing model_patch raises
  inside the run worker (caught), so the run exits 0 with NO per-instance
  report. get_dataset_from_preds() also filters out empty-string/None
  model_patch ("empty_patch_ids") — those instances are never run and never
  get a report.

Test-support knobs (see tests/benchmark/fakes/README.md §7):
- PINNED_HARNESS_CAPTURE: append one JSON row per invocation to
  $PINNED_HARNESS_CAPTURE/invocations.jsonl.
- PINNED_HARNESS_VERDICT: "resolved" (default) or "unresolved" — the verdict
  written into the per-instance report.
- PINNED_HARNESS_NO_REPORT=1: exit 0 but write no report (error bucket).
- PINNED_HARNESS_FAIL=1: exit 1 (harness-level infrastructure failure).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# The pinned argparse surface (long form -> (takes_value, kind)); short aliases
# map to the same destinations. Values: "str", "int", "nargs+", "bool".
PINNED_OPTIONS: dict[str, tuple[str, str]] = {
    "--dataset_name": ("str", "required=False"),
    "--split": ("str", "default=test"),
    "--instance_ids": ("nargs+", "optional"),
    "--predictions_path": ("str", "required=True"),
    "--max_workers": ("int", "default=4"),
    "--open_file_limit": ("int", "default=4096"),
    "--timeout": ("int", "default=1800"),
    "--run_id": ("str", "required=True"),
    "--rewrite_reports": ("bool", "default=False"),
    "--report_dir": ("str", "default=."),
    "--modal": ("bool", "default=False"),
}
PINNED_SHORTS = {
    "-d": "--dataset_name",
    "-s": "--split",
    "-i": "--instance_ids",
    "-p": "--predictions_path",
    "-t": "--timeout",
    "-id": "--run_id",
}


def argp_error(message: str) -> "SystemExit":
    print(f"pinned-harness-logic: {message}", file=sys.stderr)
    raise SystemExit(2)  # argparse exits 2 on usage errors


def parse_pinned(argv: list[str]) -> dict[str, object]:
    """Mirror of the pinned commit's argparse for run_evaluation."""
    flags: dict[str, object] = {}
    index = 0
    while index < len(argv):
        token = argv[index]
        long = PINNED_SHORTS.get(token, token)
        if long not in PINNED_OPTIONS:
            argp_error(f"unrecognized argument: {token}")
        kind, _meta = PINNED_OPTIONS[long]
        if kind == "bool":
            # str2bool consumes a value only if the next token is not a flag.
            if index + 1 < len(argv) and not argv[index + 1].startswith("-"):
                flags[long] = argv[index + 1]
                index += 2
            else:
                flags[long] = "false"
                index += 1
            continue
        if index + 1 >= len(argv):
            argp_error(f"argument {long}: expected one argument")
        value = argv[index + 1]
        if kind == "nargs+":
            values = [value]
            index += 2
            while index < len(argv) and not argv[index].startswith("-"):
                values.append(argv[index])
                index += 1
            flags[long] = values
            continue
        if kind == "int":
            try:
                value = int(value)
            except ValueError:
                argp_error(f"argument {long}: invalid int value: {value!r}")
        flags[long] = value
        index += 2
    for required in ("--predictions_path", "--run_id"):
        if required not in flags:
            argp_error(f"the following argument is required: {required}")
    return flags


def load_predictions(predictions_path: str) -> list[dict]:
    """get_predictions_from_file() semantics for .jsonl/.json inputs."""
    if predictions_path.endswith(".jsonl"):
        with open(predictions_path, "r") as handle:
            predictions = [json.loads(line) for line in handle]
    elif predictions_path.endswith(".json"):
        with open(predictions_path, "r") as handle:
            predictions = json.load(handle)
        if isinstance(predictions, dict):
            predictions = list(predictions.values())
        if not isinstance(predictions, list):
            raise ValueError(
                "Predictions must be a list[prediction] or a dictionary[instance_id: prediction]"
            )
    else:
        raise ValueError("Predictions path must be .json or .jsonl")
    for pred in predictions:
        if not isinstance(pred, dict):
            raise ValueError(f"Each prediction must be a dictionary, got {type(pred)}")
        if "instance_id" not in pred:
            raise ValueError("Each prediction must contain 'instance_id'")
    return predictions


def main(argv: list[str]) -> int:
    if argv[:2] != ["-m", "swebench.harness.run_evaluation"]:
        argp_error("this stand-in only answers -m swebench.harness.run_evaluation")
    flags = parse_pinned(argv[2:])

    capture = os.environ.get("PINNED_HARNESS_CAPTURE")
    predictions_path = str(flags["--predictions_path"])
    run_id = str(flags["--run_id"])

    # get_dataset_from_preds(): a missing model_name_or_path is a pre-run
    # KeyError — the pinned harness dies non-zero before anything is evaluated.
    predictions = load_predictions(predictions_path)
    for pred in predictions:
        if "model_name_or_path" not in pred:
            print(
                "pinned-harness-logic: prediction missing model_name_or_path (pre-run KeyError)",
                file=sys.stderr,
            )
            return 1

    if capture:
        Path(capture).mkdir(parents=True, exist_ok=True)
        row = {
            "cwd": os.getcwd(),
            "argv": argv,
            "flags": flags,
            "predictions": predictions,
        }
        with open(Path(capture) / "invocations.jsonl", "a") as handle:
            handle.write(json.dumps(row) + "\n")

    if os.environ.get("PINNED_HARNESS_FAIL") == "1":
        print("pinned-harness-logic: simulated harness infrastructure failure", file=sys.stderr)
        return 1

    instance_ids = flags.get("--instance_ids") or [pred["instance_id"] for pred in predictions]
    for instance_id in instance_ids:
        pred = next((p for p in predictions if p["instance_id"] == instance_id), None)
        if pred is None:
            # get_dataset_from_preds(): prediction ids not in the dataset raise.
            print(
                f"pinned-harness-logic: Some prediction IDs not found in dataset! Missing: {instance_id}",
                file=sys.stderr,
            )
            return 1
        patch = pred.get("model_patch")
        if patch in ("", None) or "model_patch" not in pred:
            # Empty/missing patches are filtered out before any run: no
            # container, no per-instance report. The pinned run still exits 0.
            print(f"Instances with empty patches: 1")
            continue
        # run_instance(): the report lands under the model_name_or_path with
        # "/" rewritten to "__", one directory per instance, cwd-relative.
        model_dir = pred.get("model_name_or_path", "None").replace("/", "__")
        log_dir = Path("logs/run_evaluation") / run_id / model_dir / str(instance_id)
        log_dir.mkdir(parents=True, exist_ok=True)
        resolved = os.environ.get("PINNED_HARNESS_VERDICT", "resolved") != "unresolved"
        report = {
            str(instance_id): {
                "patch_is_None": patch is None,
                "patch_exists": True,
                "patch_successfully_applied": True,
                "resolved": resolved,
                "infra_failure": False,
            }
        }
        if os.environ.get("PINNED_HARNESS_NO_REPORT") != "1":
            with open(log_dir / "report.json", "w") as handle:
                handle.write(json.dumps(report, indent=4))
    print("All instances run.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
