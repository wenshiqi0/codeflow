# Real-mode process fakes — the seam contract

Real mode is `codeflow benchmark run` **without** `--fixture`: a real Codeflow
process per instance attempt, the official SWE-bench harness for verdicts,
workspace provisioning at `base_commit`, and (optionally) hub dataset
resolution. Everything here runs **offline**: the four environment variables
below let the acceptance tests substitute process-level fakes for the three
external commands and the dataset fetch. The production implementation must
honor these overrides; the fake executables in this directory implement the
other side of each contract and are test-support only.

Design refs: docs/benchmark-design.md §2–§5, §9, §14; product contract
docs/benchmark-contract.md §1.7, §2. These variables are ignored in fixture
mode.

---

## 1. `CODEFLOW_BENCHMARK_DRIVER_BIN=<executable>` — the Codeflow process

The runner spawns **one process per instance attempt**:

```text
<bin> --workspace <workspaceDir> --attempt <n> --model-config <id>
```

- **stdin**: exactly one JSON document — the model-visible instance
  projection (contract §1.1): `instance_id`, `repo`, `base_commit`,
  `problem_statement`, and nothing else. The runner closes stdin after
  writing. Evaluator-only data must never reach argv, stdin, the child
  environment, or any file the process can see.
- **stdout**: NDJSON — one serialized `DriverEvent` (contract §1.7) per line,
  streamed. The runner reads lazily, records usage/tool-call/failed-attempt
  ledgers from the events, and re-checks budgets after every event.
- **Termination**: on a budget cap the runner stops reading, sends
  **SIGTERM**, and escalates to SIGKILL only after a short grace period. The
  process is expected to exit promptly on SIGTERM.
- **exit codes**: `0` after the attempt's natural end; any non-zero exit (or
  dying before a natural end) is an execution `infra_error` for the attempt —
  never silently retried, never reported as `unresolved`.

## 2. `CODEFLOW_BENCHMARK_HARNESS_BIN=<executable>` — the official evaluator

The runner spawns **one process per evaluated attempt**:

```text
<bin> --predictions <predictions.jsonl> --run-id <evaluationRunId> --instance <instanceId>
```

- The predictions file contains the attempt's prediction with **exactly** the
  three official keys (`instance_id`, `model_name_or_path`, `model_patch`).
- `--run-id` is the attempt's unique evaluation run id (contract §1.7
  `newEvaluationRunId`) — the official harness caches by `run_id +
  instance_id`, so distinct attempts must never reuse one.
- **stdout**: the last non-empty line is exactly one of
  `resolved | unresolved | infra_error | not_evaluated`; exit `0`.
- **exit `127`** means *evaluator unavailable* (docker/toolchain missing):
  the attempt records `not_evaluated` and the run output explicitly reports
  **unexecuted external verification** (design §14) — never a fabricated
  verdict and never a silent pass.
- Any other non-zero exit, or no parsable verdict token, is `infra_error`.

## 3. `CODEFLOW_BENCHMARK_REPO_CLONE_BIN=<executable>` — workspace provisioning

Before spawning the driver, the runner provisions a fresh isolated workspace
for the attempt (design §4: 全新隔离工作区 at `base_commit`):

```text
<bin> <repo> <base_commit> <workspaceDir>
```

- Postcondition: `workspaceDir` is a git working tree whose `HEAD` is exactly
  `base_commit`. Production default clones the dataset `repo` at
  `base_commit` (network); tests point this at a local bare source repo.
- The runner must never mutate the dataset cache, any source clone, or the
  Codeflow checkout itself (design §4); provisioning only ever writes inside
  the attempt's workspace directory.

## 4. `CODEFLOW_BENCHMARK_DATASET_FETCH_BIN=<executable>` — hub dataset resolution

When `--dataset` is a hub id (`owner/name`, e.g. `SWE-bench/SWE-bench_Verified`)
rather than an existing local snapshot file, the runner resolves it by
spawning:

```text
<bin> <hub-id>
```

- **stdout**: exactly one complete snapshot JSON document in the contract
  §1.1 shape, carrying the **exact resolved 40-hex `revision`** and
  `harness_commit`. The resolved document is validated exactly like a local
  snapshot; a movable alias (`main`, `latest`) is rejected loudly.
- The manifest records `dataset.source: "hub"` and the resolved revision —
  never the alias that was asked for.

## 5. `CODEFLOW_BENCHMARK_HUB_API_BASE` / `CODEFLOW_BENCHMARK_HUB_SERVER_BASE` — the offline Hub for the PRODUCTION fetch script

The production default behind `CODEFLOW_BENCHMARK_DATASET_FETCH_BIN` is
`benchmark/scripts/hub-fetch.ts` (§4's live boundary: the only code
path that talks to the HuggingFace Hub). Design §2 requires row retrieval to
be pinned to the exact resolved 40-hex revision — for the FIRST rows request
and EVERY paginated follow-up — so resolution and retrieval cannot race. The
pinning tests exercise the production script itself, offline, by pointing it
at `tests/benchmark/fakes/hub-server.ts` (an in-process fake Hub served on
127.0.0.1) through two base overrides the script must honor:

- `CODEFLOW_BENCHMARK_HUB_API_BASE` (default `https://huggingface.co/api`) —
  metadata: `GET ${base}/datasets/<hub-id>` answers `{ sha }`, the resolved
  default-branch head.
- `CODEFLOW_BENCHMARK_HUB_SERVER_BASE` (default
  `https://datasets-server.huggingface.co`) — datasets-server:
  `GET ${base}/splits?dataset&revision` and
  `GET ${base}/rows?dataset&config&split&offset&length&revision`.

After resolution, every request to the datasets-server — `/splits` and every
`/rows` page — must carry `revision=<the exact resolved 40-hex sha>`, and the
snapshot document must record that same sha. The fake Hub mirrors real
`/rows` semantics for the race: a request WITHOUT `revision` is served from
the current head (so an unpinned page silently follows a head that moved
mid-pagination), a request WITH `revision` from exactly that dataset state.

Offline guarantee: the pinning tests additionally route egress through an
unroutable local proxy (`HTTPS_PROXY=http://127.0.0.1:9` and friends) with
`NO_PROXY=127.0.0.1,localhost`, so even a seam-ignoring implementation can
never leave the host — it fails in milliseconds instead of reaching the real
Hub.

## 6. The tool-network wall probes — `NET_PROBE_URL` / `NET_PROVIDER_URL` (design §4)

Design §4: benchmark mode must MECHANICALLY deny outbound network for Agent
tool execution (root AND delegated roles) while the model-provider network
stays separately available. The SSOT leaves the enforcement MECHANISM open;
these tests pin the mechanism CLASS and the observable behavior (flagged in
TESTPLAN.md): the wall must be delivered through the environment the
production `codeflow-driver.ts` gives its spawned Codeflow process tree, so
that ORDINARY HTTP CLIENTS inheriting that environment — a curl subprocess
and a bun/undici fetch, the two client families real tools use — cannot
reach non-exempt destinations, from the root role and from delegated-role
children alike (delegated children launch through
`runtime/extensions/codeflow-task/role-launcher.ts`, which spreads
`{ ...process.env }` — the wall rides that inheritance; no tool-argument
parsing, which design §12 disfavors). A prompt line or manifest field alone
is not enforcement and does not pass these tests.

Stand-ins (all loopback; no real internet is reachable from any probe):

- `NET_PROBE_URL` — the internet stand-in, served on `http://127.0.0.1:<port>/`
  (`fakes/net-recorder.ts`). NOT a configured provider endpoint: every
  outbound attempt to it from inside the walled tree must FAIL (curl and
  fetch) and the recorder must observe ZERO requests. Because it is a plain
  loopback ADDRESS, a wall that blanket-exempts loopback (e.g.
  `NO_PROXY=127.0.0.1`) fails these tests: the exemption must be exactly the
  configured provider endpoints, nothing broader.
- `NET_PROVIDER_URL` — the provider stand-in, served on
  `http://localhost:<port>/`. The tests wire `MEROUTER_BASE_URL` (the
  runtime's env-configured provider seam, local `providers.json`) to this
  URL; it must stay reachable from the SAME walled tree, root and delegated
  — the two networks of §4 are exempted separately.

Probes and markers:

- `inner-codeflow.sh` `FAKE_INNER_MODE=netprobe` (driven through the
  PRODUCTION driver via `CODEFLOW_BENCHMARK_CODEFLOW_BIN`) performs the
  root-role attempts and writes `netprobe-root.json`
  (`internet_curl`/`internet_fetch`/`provider_curl`/`provider_fetch`, each
  `{exit, reached}`, plus diagnostic env-var NAMES). It then runs the
  delegated chain: `role-net-driver.ts` drives the REAL `runRoleChild`, whose
  spawned "pi" child (the same file, selected by `--mode json` in argv — the
  launcher re-invokes the current script) performs the same four attempts
  and writes `delegated-probe.json` + `delegated-run.json`
  (`{success, exitCode, content_head, stderr_head}`).
- `NET_PROBE_BUN` — the bun binary for the fetch probes (tests pass
  `process.execPath`); `NET_ROLE_NET_DRIVER` — path to `role-net-driver.ts`;
  `NET_SKIP_DELEGATED=1` — controls that exercise only the root probe.
- `FAKE_HARNESS_NET_URL` — when set, the fake harness makes one REAL HTTP
  request to that loopback URL ("evaluator upstream") and records
  `{url, exit_code, ok}` as `net_check` in its `harness-calls.jsonl` row,
  proving the evaluator invocation channel stays reachable in the very run
  whose agent tree is walled.
- The control cases run the same probes WITHOUT the production driver
  (no benchmark env) and MUST keep reaching the internet stand-in — proving
  the harness is valid and that blocking is attributable to benchmark mode
  alone (no behavior change outside it).

Driver/run wiring the tests use (see `tests/benchmark/tool-network-wall.test.ts`):
no ambient proxy variables (clean baseline), `MEROUTER_BASE_URL` +
`MEROUTER_API_KEY` set to the provider stand-in, and the production default
seams otherwise. The implemented wall (benchmark/lib/tool-network.ts,
applied by the production driver to its spawned tree's env): every proxy
variable → the unlistening loopback proxy `http://127.0.0.1:9`, and
`NO_PROXY` = EXACTLY the hostnames from checked-in `runtime/models.json` plus
configured local `providers.json` endpoints (loaded the same way the runtime
registers them) — overwriting, never merging, ambient proxy config.

---

## 7. `pinned-harness-python3` + `pinned-harness-logic.py` — the OFFICIAL harness at the pinned commit, offline

Used by `tests/benchmark/swebench-harness-contract.test.ts` to test the
PRODUCTION evaluator wrapper (`benchmark/scripts/swebench-harness.sh`)
against what SWE-bench/SWE-bench at commit
`7a21e05772954cc81471ae19d56f436cecf43c54` ACTUALLY does — never against an
invented CLI or report layout. The test symlinks `pinned-harness-python3` as
`python3` first on PATH (a stub `docker` answers `docker info`, a recording
`git` stub exits 99 so any clone attempt fails loudly), and pre-creates the
wrapper's `$CODEFLOW_BENCHMARK_HARNESS_CACHE/SWE-bench-<commit>/` checkout dir
so no network is ever needed.

Two modes (`pinned-harness-python3` dispatches on argv):

- `python3 -m swebench.harness.run_evaluation <flags>` → the pinned-commit
  simulation, executed by the REAL local python3 named in
  `PINNED_HARNESS_REAL_PYTHON3` via `PINNED_HARNESS_LOGIC`. It validates the
  flags against the pinned argparse surface (unknown flag ⇒ exit 2), enforces
  the pinned predictions field requirements (missing `instance_id` ⇒
  non-zero; missing/empty `model_patch` ⇒ run completes with no per-instance
  report), and materializes the per-instance report exactly where that commit
  writes it — cwd-relative
  `logs/run_evaluation/<run_id>/<model_name_or_path with '/'→'__'>/<instance_id>/report.json`
  — in the `grading.get_eval_report()` shape `{"<instance_id>":
  {"resolved": <bool>, …}}`.
- anything else (notably the wrapper's own `python3 - <report> <instance>`
  heredoc verdict call) → `exec` the real python3 unchanged: the wrapper's
  own embedded parsing code is what runs and is graded.

Knobs: `PINNED_HARNESS_CAPTURE` (append one JSON row per harness invocation —
  `{cwd, argv, flags, predictions}` — to `invocations.jsonl`);
`PINNED_HARNESS_VERDICT=resolved|unresolved` (the report's `resolved` value);
`PINNED_HARNESS_NO_REPORT=1` (completed run, no report);
`PINNED_HARNESS_FAIL=1` (harness infrastructure failure, exit 1).

Ground-truth sources at the pinned commit (fetched once at authoring time,
never inside tests): `swebench/harness/run_evaluation.py` (`__main__` argparse
+ `run_instance()` report layout), `swebench/harness/constants/__init__.py`
(`RUN_EVALUATION_LOG_DIR = Path("logs/run_evaluation")`, `LOG_REPORT =
"report.json"`), `swebench/harness/grading.py` (`get_eval_report()`),
`swebench/harness/reporting.py` (`make_run_report()` — the run-level
`resolved_ids` artifact is a DIFFERENT file, `<report_dir>/<model>.<run_id>.json`),
`swebench/harness/utils.py` (`get_predictions_from_file()`).

---

## 8. Staging tool-row attribution — provider/model on every tool-calls row (design §7)

Every tool-call ledger row carries DIRECT `provider`/`model` attribution
from the context that emitted the call (the assistant response — the same
attribution the usage ledger records), alongside role/goal/lane. Both fakes
that write staging rows speak that schema:

- `inner-codeflow.sh` `tool_row()` stamps `provider` (default
  `fake-anthropic`) and `model` (default `fake-coder`) on every row —
  optional args 4/5 exist so future scenarios can vary them.
- `codeflow-driver.ts` stream mode emits standalone `tool_calls` events
  with the emitting round's `provider`/`model` (`fake-anthropic`/
  `fake-stream`), exactly as the production `codeflow-driver.ts` forwards
  staging-row attribution. The business suite pins this in
  `tool-attribution.test.ts` (ATTR-*/EXT-*/RUN-*/CHAIN-*/CNT-*/PRIV-*).

Privacy is unchanged: rows stay id/name/status/timestamps/attribution only;
extra keys are refused at write time by `appendToolCallRecord`.

## The fake executables (test-support)

| file | stands in for | configured by |
| --- | --- | --- |
| `codeflow-driver.ts` | the real Codeflow process | `FAKE_CAPTURE_DIR`, `FAKE_DRIVER_SCRIPT`, `FAKE_DRIVER_MODE=script\|marathon\|stream`, marathon knobs `FAKE_MARATHON_{DELAY_MS,TOKENS,TOOLS,MAX_ROUNDS}`, stream knobs `FAKE_STREAM_{DELAY_MS,ROUNDS,TOOLS_PER_ROUND,TOKENS}` |
| `inner-codeflow.sh` | the `codeflow` binary the PRODUCTION driver script spawns | `CODEFLOW_BENCHMARK_CODEFLOW_BIN` (on the production `codeflow-driver.ts`), `FAKE_INNER_MODE=scripted\|forever\|fail\|netprobe`, `FAKE_INNER_INTERVAL_MS`, `FAKE_INNER_CAPTURE_DIR`, netprobe env per §6 (`NET_PROBE_URL`, `NET_PROVIDER_URL`, `NET_PROBE_BUN`, `NET_ROLE_NET_DRIVER`, `NET_SKIP_DELEGATED`) |
| `swebench-harness.ts` | the official SWE-bench evaluator | `FAKE_CAPTURE_DIR`, `FAKE_HARNESS_VERDICTS` (JSON map instance→verdict; absent ⇒ `not_evaluated`), `FAKE_HARNESS_MODE=unavailable` (exit 127) |
| `repo-clone.ts` | cloning `repo@base_commit` | `FAKE_CAPTURE_DIR`, `FAKE_CLONE_SOURCE` (a local bare repo containing the base commits) |
| `hub-server.ts` | the HuggingFace Hub + datasets-server for the PRODUCTION `hub-fetch.ts` | imported in-process (never spawned); states/rows/`maxPageLength`/`moveHeadAfterRowsRequests` options; every request recorded for the revision-pinning assertions |
| `net-recorder.ts` | the internet/provider/evaluator loopback stand-ins for the tool-network wall tests (§6) | imported in-process (never spawned); `startNetRecorder("internet\|provider\|evaluator")`; records every hit |
| `role-net-driver.ts` | the delegated-role "pi" child spawn path through the REAL `role-launcher.ts` (§6) | `FAKE_ROLE_NET_CAPTURE`, `NET_PROBE_URL`, `NET_PROVIDER_URL`; probe mode auto-selected by `--mode json` in argv |
| `dataset-fetch.ts` | hub dataset download/pinning | `FAKE_CAPTURE_DIR`, `FAKE_FETCH_SNAPSHOT` (path printed to stdout), `FAKE_FETCH_MODE=alias` (prints the snapshot with `revision: "main"`) |
| `pinned-harness-python3` (+ `pinned-harness-logic.py`) | `python3` for the PRODUCTION evaluator wrapper — the OFFICIAL SWE-bench harness at commit `7a21e057…` (§7) | `PINNED_HARNESS_REAL_PYTHON3`, `PINNED_HARNESS_LOGIC`, `PINNED_HARNESS_CAPTURE` (`invocations.jsonl`), `PINNED_HARNESS_VERDICT`, `PINNED_HARNESS_NO_REPORT=1`, `PINNED_HARNESS_FAIL=1` |

Fake captures (all under `FAKE_CAPTURE_DIR`, `<pid>`-suffixed):

- `driver-spawn-<pid>.json` — `{argv, stdin, env, workspace, workspace_head}`
  (everything the driver process received; the leakage tests scan all of it);
  `driver-pid-<pid>` — the pid; `driver-terminated-<pid>` — written by the
  SIGTERM handler (proves the runner terminated, not SIGKILL-only, and that
  supervision applied to a live process); `driver-natural-exit-<pid>` —
  written by EVERY mode's natural completion path (proves a budget-stopped
  process was killed before finishing: it would otherwise have continued).
- `driver-ledger-observations-<pid>.jsonl` — stream mode only: before every
  emission (and in the SIGTERM handler) the LIVE process records
  `{phase, usage_rows, tool_rows, at}` — the row counts it can see in the
  runner-written attempt ledgers (`usage.jsonl`/`tool-calls.jsonl` one dir
  above its workspace). This is the process-level proof that the runner
  streams ledgers to disk incrementally, not at exit (REAL-16..19).
- `driver-emitted-<pid>.jsonl` — stream mode only: `{seq, type, at}` per
  emitted event, so tests can prove exactly how far the process got before
  the supervisor killed it.
- `harness-calls.jsonl` — one row per evaluation: `{argv, run_id, instance,
  predictions_path, prediction_keys}` plus `net_check` (`{url, exit_code,
  ok}`) when `FAKE_HARNESS_NET_URL` is set (§6).
- `netprobe-root.json` / `delegated-probe.json` / `delegated-run.json` — the
  §6 wall probe outcomes (root role; delegated-role child of the real
  role-launcher; the launcher run itself).
- `clone-calls.jsonl`, `fetch-calls.jsonl` — one row per invocation.

The scripted driver plays, per instance (from `FAKE_DRIVER_SCRIPT`), an
ordered step list `{event?, sleep_ms?, write?: {path: content}}`: emit the
`DriverEvent` line, sleep, then write files into the workspace. `marathon`
mode emits budget-sized rounds forever (one write after each round's sleep),
so a cap must stop a live process mid-flight. `stream` mode speaks the
PRODUCTION event protocol of `benchmark/scripts/codeflow-driver.ts`:
round events carry usage only (no attached `tool_calls`), every terminated
tool call is its own standalone `tool_calls` event, one workspace file is
written per round, and the process observes the runner's ledgers before each
emission — pinning that tool-call budgets supervise the live process between
model responses and that ledgers land while the process is alive.

`inner-codeflow.sh` is a different layer: it does not stand in for the driver,
but for the `codeflow` binary that the PRODUCTION
`benchmark/scripts/codeflow-driver.ts` spawns as
`bash <bin> exec "<prompt>"` (`CODEFLOW_BENCHMARK_CODEFLOW_BIN`, default
`runtime/bin/codeflow`). It appends rows to the staging ledger dir in the same
schema `runtime/extensions/telemetry-ledger` writes, so
`tests/benchmark/driver-streaming.test.ts` can pin the production script's own
behavior offline: ledger rows stream as DriverEvents while the inner process
is alive, SIGTERM is forwarded to it, and the driver's exit code mirrors the
inner one. Its markers (`inner-pid`, `inner-argv`, `inner-terminated`,
`inner-natural-exit`) live under `FAKE_INNER_CAPTURE_DIR`.
