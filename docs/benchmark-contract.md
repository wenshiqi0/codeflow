# Benchmark contract

The official SWE-bench evaluator decides patch correctness. An Agent Receipt,
outer Task finish, successful CLI exit, or passing local tests never replaces
that verdict. Infrastructure failures and unavailable evaluation remain distinct
from an unresolved candidate.

## Execution methods

`codeflow benchmark run` is a **single-executor entry baseline**: the driver starts
one Pi execution per instance attempt, without an inner organizer loop. Pi's
shell can call codeteam; the method label is not proof of a leaf-only execution
or a complete cross-Task usage measurement. It continues
to provision fresh workspaces, collect privacy-safe Pi telemetry, extract the
candidate patch, and invoke the official evaluator. It is not a measurement of
the outer host's orchestration. New manifests explicitly set
`execution_method: "single-executor"`; the v7 manifest field is optional solely
to read historical artifacts. Report v5 marks missing historical method data as
`legacy-unspecified`, never inferring that old runs used the new baseline.
Spontaneous-split eligibility is zero and its rate unavailable for this baseline.

`benchmark prepare` and `benchmark evaluate` support external, dynamic
`codeteam` orchestration without introducing another inner Manager. These
commands never start a model.

## Two-phase outer-managed evaluation

`prepare --dataset <pin> --instances <allowlist-file> --out <new-dir>` provisions
one fresh attempt for every selected case in dataset order. The destination must
not exist. It publishes a separate `prepared-run.json` v1 only after all
workspaces are ready. Per-attempt `issue.json` contains exactly
`instance_id`, `repo`, `base_commit`, and `problem_statement`. Gold patches,
test patches, hidden test lists, hints, and future unknown dataset fields never
enter that projection or the prepared manifest. Provisioning failure leaves a
visible partial directory, not a fabricated ready result.

The manifest pins dataset revision, harness revision, Codeflow commit, and each
workspace's synthetic baseline commit and tree. The host works only in that
case's workspace and keeps changes uncommitted. The host starts and dynamically
controls one outer Task there using `codeteam`, then explicitly finishes it.
Task/Goal/Commitment/Receipt remain Runtime objects; preparation introduces no
new model-facing work protocol or mandatory organization plan.

`evaluate --run <prepared-dir> --task <task-id> --model-config <setup-label>`
requires the Task to belong to exactly one prepared workspace, have status
`completed` or `blocked`, have no open Commitments, and have every Agent idle or
interrupted with both execution and runner PIDs cleared. A Task merely being
quiet or having a dead PID is insufficient. The workspace HEAD and baseline tree
must remain unchanged. Runtime rejects further work after Task finish.

After these checks, an exclusive per-case `evaluation/` directory reserves the
single evaluation. The command freezes a hygiene-filtered patch in the official
three-key `prediction.jsonl`, then invokes the existing official evaluator with
a unique evaluation run id. It writes `result.json` v1 containing the official
verdict, Task attribution, patch SHA-256, and available Pi usage. Repeating the
command never silently overwrites or reruns that evaluation; an incomplete
evaluation directory remains visible and requires a new prepared attempt.
`benchmark report` recognizes this separate format and only reads historical
results; cases without a result remain `not_evaluated`.

Outer-host conversation isolation and tool-network enforcement cannot be
attested by these commands. Prepared artifacts explicitly say `not_attested`,
and their reports say `not_official: true`: the official evaluator outcome is
real, but this is not an attested leaderboard score or proof of orchestration
quality. Pi executor/service usage is attributed to the actual Task; outer-host
usage is unavailable and must never be fabricated as zero. An absent Pi ledger
also yields unavailable usage, not an invented zero-call execution. The setup
label must describe the actual outer configuration, not just the Pi model.

## Shared official evaluator and workspace boundary

The evaluator uses the dedicated Python at
`$CODEFLOW_BENCHMARK_HARNESS_CACHE/swebench-venv/bin/python3`, or
`CODEFLOW_BENCHMARK_HARNESS_PYTHON`. The wrapper checks that interpreter and its
Docker SDK before invoking the pinned harness, explicitly selecting the dataset
and test split. A conflicting prepared-dataset override or harness pin is rejected.
Verdicts require the official per-instance report's strict boolean `resolved`
field, never model prose or truthy malformed values. The reused wrapper selects
the evaluator dataset by id/test split, not by the prepared snapshot revision;
that revision pins model input, not an independently attested evaluator download.
The harness cache directory names the pinned commit, but an existing cache's
HEAD is not re-attested by this wrapper. These provenance limits are another
reason prepared runs must remain `not_official`, even after a resolved verdict.

Workspace provisioning reads the requested tree from
`$CODEFLOW_BENCHMARK_REPO_CACHE_DIR/<repo-name>` or `$HOME/Documents/swe/<repo-name>`
before falling back to a source clone. It never fetches into or mutates that cache.
Each attempt materializes `base_commit`, then replaces Git history with one
synthetic baseline so later upstream history cannot supply the answer. Patch
extraction excludes Runtime artifacts and records stripped binary paths.

Execution and evaluator availability are independent. `not_evaluated` means no
official verification, `infra_error` records infrastructure failure, and
`resolved`/`unresolved` are official model-outcome verdicts. Missing results stay
visible and never silently shrink the benchmark population.

## Telemetry and retired Codemark

The append-only Pi usage and tool ledgers retain privacy-safe attribution:
Task, Goal, Commitment, provider/model, internal `worker`/`service` kind,
timestamps and counts. Commands, tool arguments/results, model prose,
transcripts and hidden reasoning are not benchmark telemetry. Canonical
Commitments and Receipt chains provide execution diagnostics; outer Task finish
is a separate host-owned outcome, not a synthetic Agent Receipt.

Run-facts schema v3 records bounded prompt/tool/context shapes and cache-prefix
transitions. Model-visible utilization notifications occur at 50% and 70%; the
80% safety interruption stops further provider requests while preserving open
Commitments. Wall time is telemetry, not a ranking axis. Cache hit rate is
token-weighted and unavailable when source metrics are missing.

Codemark's old inner-Agent first-turn live experiment is retired and fails
closed before any provider call or artifact creation. `codemark report --run`
reads frozen v1 artifacts without equating their simulated four-action frontier
to today's executor tool surface or to the outer host's organization. Existing
serialized manager/worker keys remain historical artifact data only.
