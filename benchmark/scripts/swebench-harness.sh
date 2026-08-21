#!/usr/bin/env bash
#
# Production default for CODEFLOW_BENCHMARK_HARNESS_BIN (the seam contract in
# tests/benchmark/fakes/README.md §2): the OFFICIAL SWE-bench Docker evaluator,
# pinned to the design-time harness commit 7a21e05772954cc81471ae19d56f436cecf43c54
# (docs/benchmark-design.md §2).
#
#   <this> --predictions <predictions.jsonl> --run-id <evaluationRunId> --instance <instanceId>
#
# Prints exactly one verdict token as the last stdout line:
#   resolved | unresolved | infra_error | not_evaluated
#
# Verdict authority is the official evaluator (design §9) — nothing is graded
# locally. This wrapper only translates what the pinned commit actually does:
#
#   - run_evaluation is invoked as `python3 -m swebench.harness.run_evaluation`
#     from the pinned-commit checkout, with an explicit --dataset_name: that
#     commit's own argparse default is SWE-bench/SWE-bench_Lite, so the
#     benchmark's dataset must never fall through to the harness default.
#   - run_instance() writes the per-instance report at the cwd-relative path
#     logs/run_evaluation/<run_id>/<model dir>/<instance_id>/report.json
#     where the model dir is the prediction's model_name_or_path with every
#     '/' rewritten to '__' (RUN_EVALUATION_LOG_DIR / LOG_REPORT in
#     swebench/harness/constants). The run-level id lists belong to a
#     DIFFERENT artifact — make_run_report()'s <report_dir>/<model>.<run_id>.json
#     — which this wrapper never reads.
#   - grading.get_eval_report() shapes the per-instance report as a dict keyed
#     by instance_id whose value carries a boolean 'resolved'.
#
# Exit 127 means evaluator unavailable (python3/docker missing or the
# harness cannot start); the benchmark records not_evaluated and reports the
# run as unexecuted external verification (design §14). This is the live
# boundary: real Docker, real containers, network on first use. It is only
# exercised in live runs, never in the offline acceptance suite.

set -uo pipefail

# The design-pinned official harness commit (docs/benchmark-design.md §2).
HARNESS_COMMIT="7a21e05772954cc81471ae19d56f436cecf43c54"
# The design-pinned dataset (docs/benchmark-design.md §2). Always passed
# explicitly: the pinned run_evaluation argparse defaults to a different
# dataset, and grading against the wrong one would silently misgrade.
DATASET_NAME="${CODEFLOW_BENCHMARK_EVAL_DATASET:-SWE-bench/SWE-bench_Verified}"
CACHE_DIR="${CODEFLOW_BENCHMARK_HARNESS_CACHE:-$HOME/.cache/codeflow-benchmark}"
REPO_DIR="$CACHE_DIR/SWE-bench-$HARNESS_COMMIT"
EVAL_TIMEOUT="${CODEFLOW_BENCHMARK_EVAL_TIMEOUT:-3600}"

usage() { echo "usage: $0 --predictions <file> --run-id <id> --instance <id>" >&2; exit 2; }

predictions=""
run_id=""
instance=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --predictions) predictions="${2:-}"; shift 2 ;;
    --run-id)      run_id="${2:-}"; shift 2 ;;
    --instance)    instance="${2:-}"; shift 2 ;;
    *) echo "swebench-harness: unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$predictions" ] && [ -n "$run_id" ] && [ -n "$instance" ] || usage
[ -f "$predictions" ] || { echo "swebench-harness: predictions file not found: $predictions" >&2; exit 2; }

command -v python3 >/dev/null 2>&1 || { echo "swebench-harness: python3 is not installed" >&2; exit 127; }
command -v docker >/dev/null 2>&1 || { echo "swebench-harness: docker is not installed" >&2; exit 127; }
docker info >/dev/null 2>&1 || { echo "swebench-harness: docker daemon is unreachable" >&2; exit 127; }

# The pinned run_instance() nests the per-instance report under the
# prediction's model_name_or_path with every '/' rewritten to '__'
# (defaulting the field to the literal 'None'), so the wrapper must read that
# same official field to find the report the harness actually wrote. The
# reader accepts the same .jsonl / .json prediction shapes the pinned
# get_predictions_from_file() accepts. If this attempt's prediction cannot be
# found, the model dir stays empty: the harness itself then fails or writes no
# report, so the verdict below stays not_evaluated (never fabricated).
model_dir="$(python3 - "$predictions" "$instance" <<'PYEOF'
import json, sys

predictions_path, instance = sys.argv[1], sys.argv[2]
with open(predictions_path) as handle:
    text = handle.read()
if predictions_path.endswith(".jsonl"):
    preds = [json.loads(line) for line in text.splitlines() if line.strip()]
else:
    preds = json.loads(text)
    if isinstance(preds, dict):
        preds = list(preds.values())
for pred in preds:
    if isinstance(pred, dict) and pred.get("instance_id") == instance:
        print(str(pred.get("model_name_or_path", "None")).replace("/", "__"))
        break
PYEOF
)" || model_dir=""

# Materialize the official harness at the pinned commit (cached; the cache is
# only ever appended to, never mutated in place).
if [ ! -d "$REPO_DIR" ]; then
  mkdir -p "$CACHE_DIR"
  tmp="$(mktemp -d "$CACHE_DIR/swebench-clone.XXXXXX")"
  if ! git clone --quiet https://github.com/SWE-bench/SWE-bench.git "$tmp"; then
    rm -rf "$tmp"
    echo "swebench-harness: could not clone SWE-bench" >&2
    exit 127
  fi
  if ! git -C "$tmp" checkout --quiet "$HARNESS_COMMIT"; then
    rm -rf "$tmp"
    echo "swebench-harness: harness commit $HARNESS_COMMIT not found" >&2
    exit 127
  fi
  mv "$tmp" "$REPO_DIR"
fi

# Official evaluation for exactly this attempt's instance under the attempt's
# unique evaluation run id. The harness caches by run_id + instance_id, which
# is why every attempt gets a distinct id.
cd "$REPO_DIR"
if ! python3 -m swebench.harness.run_evaluation \
    --predictions_path "$predictions" \
    --run_id "$run_id" \
    --dataset_name "$DATASET_NAME" \
    --split test \
    --instance_ids "$instance" \
    --max_workers 1 \
    --timeout "$EVAL_TIMEOUT"; then
  echo "infra_error"
  exit 0
fi

# Verdict from the official per-instance report only, in the exact shape the
# pinned grading.get_eval_report() writes: a dict keyed by instance_id whose
# value carries the boolean 'resolved'. Anything else (no report, unexpected
# shape) is not_evaluated — never a guessed verdict.
report="logs/run_evaluation/$run_id/$model_dir/$instance/report.json"
if [ ! -f "$report" ]; then
  echo "not_evaluated"
  exit 0
fi
python3 - "$report" "$instance" <<'PYEOF'
import json, sys

report = json.load(open(sys.argv[1]))
entry = report.get(sys.argv[2]) if isinstance(report, dict) else None
if isinstance(entry, dict) and "resolved" in entry:
    print("resolved" if entry["resolved"] else "unresolved")
else:
    print("not_evaluated")
PYEOF
