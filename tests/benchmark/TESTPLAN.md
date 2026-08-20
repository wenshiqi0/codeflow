# Benchmark acceptance test plan and index

Executable acceptance suite for the SWE-bench Verified benchmark capability
(`docs/benchmark-design.md`, normative §3–§11 and §13). Product contract
(SSOT) with every fixed name/shape: `docs/benchmark-contract.md`. The suite is
deterministic offline: no network, no Docker, no model calls, no dataset
download, no reading of `.codeflow/runs/` transcripts.

Run everything:

```bash
bun test tests/benchmark          # the whole suite
bun test tests/benchmark/e2e-offline.test.ts   # one file
```

Pre-implementation red is expected: module-level tests fail through
`loadBenchmarkModule()` with a pointer to the contract; CLI tests fail against
the real `runtime/bin/codeflow` binary. No file crashes on import.

## Fixtures (this directory owns them)

- `fixtures/verified-snapshot.json` — 5-instance fixed-revision snapshot with
  the full real SWE-bench field set (gold `patch`, `test_patch`,
  `FAIL_TO_PASS`, `PASS_TO_PASS`, `hints_text`, …). `CANARY_*` strings exist
  only in evaluator-only fields.
- `fixtures/attempts.json` — scripted fake Codeflow driver: multi-role rounds,
  support models, one failed provider attempt, tool calls in every status,
  workspace writes, one execution `infra_error`, simulated clock advances.
- `fixtures/verdicts.json` — fake official evaluator outcomes; absent id ⇒
  `not_evaluated`.
- `fixtures/README.md` — fixture semantics, including the demo-1005 budget
  arithmetic.
- `fakes/pinned-harness-python3` + `fakes/pinned-harness-logic.py` — offline
  stand-in for the OFFICIAL SWE-bench harness pinned at commit
  `7a21e05772954cc81471ae19d56f436cecf43c54` (its CLI surface, predictions
  field requirements, report location, and report shape); see
  `fakes/README.md` §7 for the seam and knobs.

## Case index

| id | criterion (design §) | fixture / state | action | expected observable result | boundary / risk | file | runner | signal |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CLI-1 | benchmark discoverable via `codeflow` (§10, §13.1) | repo CLI | `codeflow --help` | exit 0, stdout contains `benchmark` | capability hidden behind a new binary | cli-surface.test.ts | `bun test tests/benchmark/cli-surface.test.ts` | verb listed |
| CLI-2 | subcommand help (§10) | repo CLI | `benchmark --help`, `run --help`, `report --help` | exit 0, usage on stdout | undocumented surface | cli-surface.test.ts | same | exit 0 |
| CLI-3 | unknown args stable non-zero (§13.1) | repo CLI | unknown subcommand/option, missing `--dataset`/`--run`, malformed/unknown `--budget` | exit 2, stderr names the problem | silent passthrough to a model | cli-surface.test.ts | same | exit 2 + named error |
| CLI-4 | existing verbs regress-smoked (§13.10) | empty runs dir | `--help`, `ls`, no-arg verb calls | help lists exec/resume/ls/sub/goals/usage/audit/stop; `ls` exit 0; no-arg verbs non-zero; unknown verb still fails | benchmark work breaks the outer ring | cli-surface.test.ts | same | unchanged behavior |
| E2E-1 | offline full chain (§4, §13.2) | fixture trio | `codeflow benchmark run --dataset <snapshot> --fixture <dir> --out <tmp>` | exit 0; benchmark-run.json, predictions.jsonl, cases/*/case.json, attempts ledgers, workspace, report.json all exist | chain only works with Docker/model | e2e-offline.test.ts | `bun test tests/benchmark/e2e-offline.test.ts` | artifact set |
| E2E-2 | schema_version + whole-line writes (§10) | E2E-1 out dir | parse every .json/.jsonl | every artifact has `schema_version: 1`; every JSONL line parses; no `.tmp` leftovers | half-JSON read as a result after interruption | e2e-offline.test.ts | same | parse + no tmp |
| MAN-1 | manifest pins dataset revision/harness/codeflow commits (§2) | E2E-1 manifest | read benchmark-run.json | exact 40-hex revision + harness commit + codeflow commit; dataset id/split | moving alias recorded as a result | e2e-offline.test.ts | same | 40-hex values |
| MAN-2 | manifest records concurrency/networks/budgets/driver (§4, §5) | E2E-1 manifest | read manifest | `concurrency: 1`, `tool_network: "disabled"`, `model_provider_network`, effective budgets, `driver_mode: "fixture"`, selected instance order | unfair comparison keys missing | e2e-offline.test.ts | same | fields present |
| PRED-1 | predictions official contract (§10, §13.8) | E2E-1 predictions | read jsonl | exactly `instance_id`/`model_name_or_path`/`model_patch`, dataset order, one line per attempt | harness rejects the file | e2e-offline.test.ts, predictions.test.ts | both files | exact key set |
| PRED-2 | patch extraction incl. empty patch | E2E-1 predictions | inspect model_patch | extracted workspace diffs (`FIXED_*` markers), `""` for no-change attempt | fabricated or gold patch submitted | e2e-offline.test.ts, predictions.test.ts | same | marker present |
| PRED-3 | append-only whole lines, official keys enforced | tmp out dir | `appendPredictionEntry` good/bad, `readPredictions` on truncated file | appends produce complete lines; extra/missing keys throw; truncated line throws loudly | silent skip hides corruption | predictions.test.ts | `bun test tests/benchmark/predictions.test.ts` | throw/pass |
| EVAL-1 | verdict merge classification (§9) | E2E-1 cases | read case.json per instance | resolved / unresolved / infra_error(+execution_status) / not_evaluated / resolved-with-terminated_by | infra failure disguised as unresolved | e2e-offline.test.ts | e2e runner | per-instance verdicts |
| EVAL-2 | distinct evaluation run id per attempt (§4, §13.8) | two runs + helper | compare ids; `newEvaluationRunId` | unique across instances, attempts, and runs; namespaced by benchmark run id | official harness cache reuse | e2e-offline.test.ts, budgets.test.ts | both | uniqueness |
| MET-R1 | one response N calls = 1 round + N calls (§6, §7) | ledger unit data | `buildAttemptMetrics` | rounds 1, calls 3, ratio 3 | transcript-based counting | model-rounds.test.ts | `bun test tests/benchmark/model-rounds.test.ts` | counts |
| MET-R2 | multi-role + support models (§6) | 5-role ledger | `buildAttemptMetrics`, `classifyModelRole` | total = primary + support; support roles match roster; unknown role counted primary | support rounds lost or dropped | model-rounds.test.ts | same | splits |
| MET-R3 | failed provider attempts are not rounds (§6) | 2 rounds + 2 failures | `buildAttemptMetrics` | rounds 2, `failed_model_attempts` 2 | fast-fail rewarded as efficiency | model-rounds.test.ts | same | separation |
| MET-T1 | statuses + dedup + multi-command bash (§7, §13.5) | ledger unit data | `summarizeToolCalls` | requested = completed + incomplete; dedup by id; multi-command bash = 1; retry = new call | shell parsing inflating counts | tool-calls.test.ts | `bun test tests/benchmark/tool-calls.test.ts` | counters |
| MET-T2 | ledger holds only id/name/status/timestamps/attribution incl. provider/model (§7) | ledger unit data | `validateToolCallRecord`, `appendToolCallRecord` | allowed key set exact incl. `provider`/`model`, both required non-empty; params/command/result/secret keys rejected at write time; un-attributed rows refused | tool arguments/secrets persisted; by-model counts unattributable | tool-calls.test.ts | `bun test tests/benchmark/tool-calls.test.ts` | violations |
| MET-C1 | explicit zero vs unreported (§8, §13.6) | usage unit data | `summarizeTokenUsage` | zeros ⇒ available true (rate 0); absent ⇒ available false, rate null; one absent poisons attempt; empty ⇒ unavailable; 0/0 ⇒ null | missing cache fields laundered to 0% | tokens-cache.test.ts | `bun test tests/benchmark/tokens-cache.test.ts` | availability |
| MET-C2 | token-weighted hit rate (§8) | 2-round usage | `summarizeTokenUsage` | 90/1100, not 0.45; cache_write in denominator; reasoning not double-counted | average-of-percentages | tokens-cache.test.ts | same | exact ratio |
| MET-C3 | cost informational only (§5, §8) | usage with cost | `summarizeTokenUsage` + budgets | cost carried; budget keys are the four resource caps only | cost becomes a budget/ranking axis | tokens-cache.test.ts, budgets.test.ts | both | key sets |
| BUD-1 | default caps are the design values (§5) | module constants | read `DEFAULT_BENCHMARK_BUDGETS` | 120 / 400 / 3,000,000 / 5,400 | caps drift from the approved design | budgets.test.ts | `bun test tests/benchmark/budgets.test.ts` | constants |
| BUD-2 | override parsing + stop detection semantics | module functions | `parseBudgetOverrides`, `budgetTerminatedBy` | CLI spellings mapped; junk/zero refused; `>=` stops; canonical tie order; null when clear | off-by-one overspend | budgets.test.ts | same | values |
| BUD-3 | wall stop via simulated clock; patch still submitted (§4, §5, §13.7) | scripted driver, 3×10-min rounds, cap 600s | `runBenchmark` | terminated_by `wall_seconds`, 1 round, prediction with real patch, evaluator called, one attempt only | stop discards work or forces unresolved | budgets.test.ts | same | terminated_by + prediction |
| BUD-4 | infra failure ⇒ infra_error, no retry, evaluator skipped (§4, §13.9) | scripted driver with infra_error mid-script | `runBenchmark` | execution_status/verdict infra_error; unplayed round absent; evaluator 0 calls; partial patch preserved | silent in-attempt retry | budgets.test.ts | same | no evaluator call |
| BUD-5..8 | rounds/tool-calls/tokens/wall caps via CLI (§13.7) | demo-1005 + `--budget` overrides | CLI runs | per-cap terminated_by, capped counts, override in manifest, verdict still resolved, patch submitted | nondeterminism or lost work at stop | e2e-offline.test.ts | e2e runner | per-cap fields |
| LEAK-1 | projection is an explicit allowlist (§3, §13.3) | snapshot + invented fields | `projectModelVisibleInstance`, `MODEL_VISIBLE_INSTANCE_FIELDS` | exactly 4 keys; brand-new dataset fields cannot leak | delete-based projection leaks future fields | dataset-projection.test.ts | `bun test tests/benchmark/dataset-projection.test.ts` | exact key set |
| LEAK-2 | dataset loading integrity (§2) | mutated snapshots in tmp | `loadBenchmarkDataset`, `selectInstances` | alias revision rejected; bad harness commit rejected; duplicate ids rejected; allowlist preserves dataset order, unknown id rejected | unparseable/unfixed dataset recorded as results | dataset-projection.test.ts | same | throws |
| LEAK-3 | driver input is only the projection (§3) | spying driver over full snapshot | `runBenchmark` | every attempt input has exactly 4 instance keys; input shape exactly the contract keys; serialized input has no canary/test_patch/F2P/P2P/patch | runner passes the whole record | leakage.test.ts | `bun test tests/benchmark/leakage.test.ts` | key sets |
| LEAK-4 | workspace + artifacts + evaluator stay clean (§3) | spying driver run | scan out dir, workspace, evaluator capture | workspace = driver writes + .git only; no `CANARY_` anywhere; evaluator gets extracted patch only | hints/gold written as workspace helpers | leakage.test.ts, e2e-offline.test.ts | both | canary scan |
| LEAK-5 | model-visible ledgers carry no payloads (§3, §7) | spying driver run | read usage.jsonl / tool-calls.jsonl | attribution + numbers only; tool rows exactly the allowed key set | prompt/command text in ledgers | leakage.test.ts | same | key sets |
| REP-1 | denominator = valid verdicts; infra/not_evaluated visible (§9, §13.9) | hand-built out dir | `buildBenchmarkReport` | counts all four classes; rate = r/(r+u); resolved=0 ⇒ nulls | missing results hidden by small denominator | report.test.ts | `bun test tests/benchmark/report.test.ts` | counts/rate |
| REP-2 | per-resolved numerators include failed-but-valid attempts (§8, §13.9) | hand-built 4-attempt out dir | `buildBenchmarkReport` | 575/850/24,000 per resolved=1; medians/P90 nearest-rank; budget terminations; cache poisoning; wall not_ranked | fast-fail efficiency advantage | report.test.ts | same | exact numbers |
| REP-3 | comparison keys + no composite score (§11) | hand-built out dir | `buildBenchmarkReport` | exact comparison key set incl. sha256 instance digest; no `score`/`composite` keys | unfair cross-config comparison | report.test.ts | same | key sets |
| REP-4 | rebuild determinism, no model calls (§10, §13.2) | E2E-1 out dir | delete report.json; `codeflow benchmark report --run <dir>` | exit 0; identical counts/rate/per-resolved/terminations | rebuild silently re-runs models | report.test.ts, e2e-offline.test.ts | both | identity |
| ATTR-1..4 | tool-call contract carries direct provider/model attribution (§7) | module surface | `TOOL_CALL_RECORD_FIELDS`, `validateToolCallRecord`, `appendToolCallRecord` | provider+model in the allowed set, required non-empty strings; un-attributed rows refused at write; payload keys still refused on attributed rows | attribution missing or smuggled payloads | tool-attribution.test.ts, tool-calls.test.ts | `bun test tests/benchmark/tool-attribution.test.ts` | field set + violations |
| EXT-1..6 | the real benchmark-ledger extension stamps rows with the EMITTING assistant context (§6/§7) | real extension + fake pi events, root and delegated env | fire `message_end`/`tool_call`/`tool_execution_end` | rows carry the response's provider/model next to role/depth/goal/lane; a multi-model role attributes each call (and its late result row) to the model that emitted it; orphan calls keep non-empty attribution; usage-less messages stay failed attempts; fed `input.command`/`result.stdout` canaries never serialize | role-level model map misattributes multi-model roles; payload leak at the emitter | tool-attribution.test.ts | same | staging rows |
| RUN-1..3 | the runner writes attributed rows from driver events (§7) | scripted drivers incl. standalone `tool_calls` events | `runBenchmark`, read `cases/<i>/attempts/1/tool-calls.jsonl` | round-attached and standalone calls carry the emitting round's provider/model + role/goal/lane; multi-call/retry/cancelled/incomplete counting unchanged | runner drops attribution or breaks counting | tool-attribution.test.ts | same | per-call rows |
| CHAIN-1 | the PRODUCTION driver forwards staging attribution on tool events (§7) | production `codeflow-driver.ts` + fake inner codeflow (scripted) | spawn the real script, consume events | standalone `tool_calls` events carry the staging rows' provider/model (fake-anthropic/fake-coder); rounds keep theirs | forwarding drops attribution between staging and runner | tool-attribution.test.ts | same | event fields |
| CNT-1..4 | report by-model tool counts equal the RECORDED provider/model grouping, never role inference (§7, §11) | hand-built out dir with multi-model roles, zero-tool usage and zero-round tool emitters; fixture run | `buildBenchmarkReport` | exact p/A vs p/B split; usage-only models and tool-only role/lane/model groups stay visible; fixture report reproduces nonzero ledger grouping | ambiguous or zero-sided dimensions silently dropped; misattributed counts | tool-attribution.test.ts | same | complete by_model/by_role/by_lane totals |
| PRIV-1..2 | deep scan: no arguments/command/results/source/credentials keys anywhere (§7) | fixture run out dir + report.json | recursive key/value scan | every `cases/*/attempts/*/tool-calls.jsonl` row and the whole report.json tree free of payload keys; provider/model typed so payloads cannot smuggle | future field smuggles a payload; secrets/PII hazard | tool-attribution.test.ts | same | empty intersection |

## Real-mode (non-fixture) acceptance

The rows above pin the offline contract; the rows below pin the path
design §4 actually describes — a real Codeflow process per attempt, real
workspace provisioning, the official harness, budgets supervising a live
process — driven offline through the process-level fakes specified in
`tests/benchmark/fakes/README.md` (env seams `CODEFLOW_BENCHMARK_DRIVER_BIN`,
`_HARNESS_BIN`, `_REPO_CLONE_BIN`, `_DATASET_FETCH_BIN`). Fixture-only
acceptance must not pass as product completion.

| id | criterion (design §) | fixture / state | action | expected observable result | boundary / risk | file | runner | signal |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| REAL-1 | non-fixture run is a first-class path (§4, §13.2, §14) | pinned local snapshot + process fakes | `benchmark run --dataset <snapshot> --out <tmp>` (NO --fixture) | exit 0; full artifact set incl. per-attempt workspaces | “only --fixture mode is implemented” accepted as done | realmode-e2e.test.ts | `bun test tests/benchmark/realmode-e2e.test.ts` | exit 0 + artifacts |
| REAL-2 | manifest pins real mode (§2, §4) | REAL-1 manifest | read benchmark-run.json | exact revision, harness commit 7a21e05…, codeflow commit == checkout HEAD, driver_mode codeflow, model_provider_network required | fixture-flavored manifest passes for real mode | realmode-e2e.test.ts | same | field values |
| REAL-3 | workspace = fresh repo@base_commit; sources unmutated (§4) | REAL-1 driver captures + source clone digest | inspect spawn workspace_head, marker.txt contents, show-ref/status digests | HEAD == base_commit per instance; base-one vs base-two content; source clone + Codeflow checkout digests unchanged | empty git init workspace; runner mutates sources | realmode-e2e.test.ts | same | HEAD/digests |
| REAL-4 | driver sees only the 4-field projection (§3) | REAL-1 driver captures (argv/stdin/env) + out-dir scan | parse spawn stdin; scan for CANARY_ | stdin keys exactly instance_id/repo/base_commit/problem_statement; no canary anywhere | gold patch leaks into the spawned process or workspace helpers | realmode-e2e.test.ts | same | key set + scan |
| REAL-5 | usage instrumentation feeds ledgers (§6) | REAL-1 usage.jsonl + failed-model-attempts.jsonl | read ledgers | 1 row per completed round with role/provider/model/handoff/goal/lane; failed attempt separate, error_class token only | rounds derived from transcripts; message text persisted | realmode-e2e.test.ts | same | rows + attribution |
| REAL-6 | tool ledger from the process (§7, §13.5) | REAL-1 tool-calls.jsonl | summarize + key scan | 5 calls: succ 2 / failed 1 / rejected 1 / incomplete 1; rows carry only id/name/status/attribution | params/results/command text persisted | realmode-e2e.test.ts | same | counts + key set |
| REAL-7 | honest report over real attempts (§8, §9, §11) | REAL-1 report.json | read aggregates | counts incl. infra_error+not_evaluated; denominator 1; per_resolved 5/7/5900 incl. failed attempts; cache unavailable ⇒ null; by_model/by_tool attribution | missing results hidden; cache laundered to 0% | realmode-e2e.test.ts | same | exact numbers |
| REAL-8 | verdict merge + harness contract (§4, §9, §13.8) | REAL-1 harness capture + case.json | correlate run_id/instance | resolved & not_evaluated graded; infra_error never sent to harness; evaluation_run_id reaching the harness == case.json id, format <bench>--<slug>--a1 | verdict fabricated locally; stale harness cache reuse | realmode-e2e.test.ts | same | correlation |
| REAL-9 | predictions official contract + extracted patches (§10) | REAL-1 predictions.jsonl | parse | 3 lines dataset order, exact 3 keys; partial patch after infra stop; "" when no writes | gold patch or fabricated patch submitted | realmode-e2e.test.ts | same | key set + markers |
| REAL-10 | re-run cannot reuse evaluation cache (§4) | second real-mode run of one instance | compare evaluation_run_id | different id on the second run | harness run_id+instance_id cache collision | realmode-e2e.test.ts | same | ids differ |
| REAL-11 | report rebuild re-invokes nothing (§10) | REAL-1 out dir | rm report.json; `benchmark report --run` | identical aggregates; driver spawns + harness calls unchanged | rebuild silently re-runs models | realmode-e2e.test.ts | same | identity + counts |
| REAL-12 | unavailable evaluator reported, never fabricated (§14) | harness fake exits 127 | run one instance | verdicts not_evaluated, execution completed, counts visible, output says unexecuted external verification | docker-less host silently passes or hides misses | realmode-e2e.test.ts | same | notice + counts |
| REAL-13 | budgets supervise a live process (§4, §5, §13.7) | marathon fake driver (runs forever) + one small `--budget` override per cap | 4 CLI runs | terminated_by per cap; pid dead + SIGTERM marker; partial patch (STEP_1 in, STEP_3 out) still submitted and graded resolved | stop discards work / forces unresolved / SIGKILL-only | realmode-budgets.test.ts | `bun test tests/benchmark/realmode-budgets.test.ts` | per-cap fields |
| REAL-16 | ledgers stream to disk while the nested process is ALIVE (§4, §1.7.1) | stream-mode fake speaking the production event protocol; it observes the runner's attempt ledgers before every emission; natural end, no cap | `benchmark run` real mode, 3 rounds + standalone tool events | live-process observations show usage/tool rows already on disk (1/4, 2/8, full 3/12 before exit); terminated marker absent; natural-exit marker present; terminated_by null | runner buffers stdout and flushes ledgers only at exit would pass REAL-13 and still violate §1.7.1 | realmode-streaming.test.ts | `bun test tests/benchmark/realmode-streaming.test.ts` | observation counts |
| REAL-17 | model-round cap kills the LIVE process mid-script; crossing round already durable (§5, §13.7) | stream-mode fake, 4 scripted rounds, `--budget model-rounds=2` | CLI run | SIGTERM marker + NO natural-exit marker + fewer events emitted than scripted; rounds=2; sigterm-time observation shows 2 usage rows; STEP_1-only partial patch still submitted + graded resolved; report counts the cap | stop discards work, masks as unresolved, or loses the crossing round | realmode-streaming.test.ts | same | terminated_by + live observations |
| REAL-18 | tool-call cap fires on the STANDALONE `tool_calls` event — no next model response needed (§1.7) | stream-mode fake (production protocol: rounds carry no tool_calls), `--budget tool-calls=2` | CLI run | stop after the 2nd standalone tool event with exactly 1 round ever emitted; terminated_by tool_calls; kill-alive markers; first tool event's rows observed on the ledger pre-kill; partial patch graded | tool budget only checked on round events (never fires between responses) | realmode-streaming.test.ts | same | mid-round stop |
| REAL-19 | token cap kills the LIVE process; crossing round fully counted (§5) | stream-mode fake, 400k tokens/round, `--budget total-tokens=1000000` | CLI run | terminated_by total_tokens at round 3 with tokens 1.2M (not 800k); sigterm-time observation shows 3 usage rows; STEP_1+2 partial patch graded; manifest+report record the override | crossing round dropped from the token ledger | realmode-streaming.test.ts | same | totals + patch |
| REAL-20 | wall cap interrupts a silent LIVE process (§5) | silent fake writes partial work then emits no events | CLI run with `--budget wall-seconds=1` | process receives SIGTERM; terminated_by wall_seconds; zero rounds; partial patch still graded | wall cap only checked after events and a silent model/tool hangs forever | realmode-budgets.test.ts | same | termination marker + zero rounds + patch |
| REAL-14 | official hub id accepted; exact resolved revision recorded (§2, §10) | fetch fake resolves hub id | `benchmark run --dataset SWE-bench/SWE-bench_Verified` | exit 0; manifest source hub, revision == resolved 40-hex (not main); fetch invoked with hub id; instance graded | hub ids rejected; alias recorded as revision | realmode-dataset.test.ts | `bun test tests/benchmark/realmode-dataset.test.ts` | manifest fields |
| REAL-15 | movable alias alone rejected (§2) | fetch fake returns revision "main" | same run | non-zero exit, stderr names revision; no report/predictions fabricated | alias laundered into a pinned-looking manifest | realmode-dataset.test.ts | same | loud failure |
| PIN-1 | first rows request and EVERY paginated follow-up carry the identical resolved 40-hex revision (§2) | fake hub serving the design dataset at the design revision 78f471b…, 5 rows over 3 pages | run the PRODUCTION hub-fetch.ts offline via the hub base seams | exit 0; 3 /rows requests at offsets 0/2/4, every one `revision == 78f471b…` (40-hex, not main/latest); document records the same sha; 5 instances in order | page 2+ unpinned → rows from a different dataset state | hub-revision-pinning.test.ts | `bun test tests/benchmark/hub-revision-pinning.test.ts` | per-page revision set |
| PIN-2 | a hub head that MOVES mid-pagination cannot leak into any page or the document (§2) | fake hub head A→B after page 1; revision-less /rows requests are served B rows (real datasets-server semantics) | same run | every /rows request still `revision == A`; head-at-request proves the race window; document carries only A's rows; document revision == A | silent mixed-state pagination | hub-revision-pinning.test.ts | same | identical revisions + row ids |
| PIN-3 | moving head cannot override the fixed dataset; other ids rejected (§2) | fake hub head `main` plus pinned state; unsupported hub id | same runs | no metadata-head lookup; every /splits + /rows request carries `78f471b…`; document contains only pinned rows; other id fails before network | current Hub head silently replaces the approved standard dataset revision | hub-revision-pinning.test.ts | same | request set + pinned rows + early rejection |
| PIN-4 | manifest records the 40-hex revision the rows ACTUALLY used — end to end (§2, §10) | real-mode CLI run, PRODUCTION fetch default (no fetch seam override), fake hub, 3 instances over 2 pages | `benchmark run --dataset SWE-bench/SWE-bench_Verified` | exit 0; manifest source hub; manifest revision == the single revision carried by every /rows request; report comparison key matches; selected instances in dataset order | manifest pins a sha the rows never used | hub-revision-pinning.test.ts | same | manifest == request set |
| NET-1 | root-role tool egress MECHANICALLY blocked inside the production driver's spawned Codeflow tree (§4) | PRODUCTION `codeflow-driver.ts` + `inner-codeflow.sh` netprobe; internet stand-in recorder on 127.0.0.1 (not a provider endpoint) | run the production driver; the probe attempts REAL outbound curl + bun fetch from inside the tree | both attempts FAIL; the recorder observes ZERO hits; driver exit 0 (a wall is not an error) | prompt line or manifest field mistaken for enforcement; wall breaks the attempt | tool-network-wall.test.ts | `bun test tests/benchmark/tool-network-wall.test.ts` | attempts fail + zero hits |
| NET-2 | the model-provider endpoint stays reachable from the SAME walled tree (§4: the two networks are separate) | NET-1 run; provider stand-in on `localhost`, wired as MEROUTER_BASE_URL (the env-configured provider seam) | same probes target the provider URL | curl AND fetch SUCCEED; the recorder observes the /root hit | wall over-blocks: provider exempt not implemented, or blanket loopback exemption instead of exact provider endpoints | tool-network-wall.test.ts | same | provider reachable |
| NET-3 | delegated-role tool egress blocked through the REAL role-launcher chain (§4; role-launcher.ts `{...process.env}` inheritance) | NET-1 run; `role-net-driver.ts` drives the real `runRoleChild` from inside the tree; its spawned "pi" child probes | delegated child attempts curl + fetch to both stand-ins | internet attempts FAIL (zero delegated hits on the recorder); provider reachable; `delegated-run.json` success true (delegation machinery unharmed); role=coder depth=1 attribution | wall covers root only; delegated children escape it; wall breaks delegation | tool-network-wall.test.ts | same | delegated blocked + provider open |
| NET-C1 | control: the same root probe OUTSIDE benchmark mode reaches the stand-in | inner netprobe spawned directly, no driver / benchmark env | run probe unwalled | curl + fetch SUCCEED; recorder sees /root | harness broken (probe/listener) masquerading as a wall; behavior changed outside benchmark mode | tool-network-wall.test.ts | same | unwalled reachable |
| NET-C2 | control: delegated probe outside benchmark mode reaches the stand-in through the real role-launcher | `role-net-driver.ts` direct, no benchmark env | run unwalled | internet reachable from the delegated child; recorder sees /delegated | benchmark mode being the only walled path is unproven | tool-network-wall.test.ts | same | unwalled reachable |
| NET-5 | one benchmark run: infra channels open while the agent tree is walled; manifest separates the networks (§4, §10) | real CLI run: PRODUCTION driver (netprobe inner) + PRODUCTION hub-fetch (fake hub) + fake harness with FAKE_HARNESS_NET_URL | `benchmark run --dataset <hub-id> --instances <1>` | exit 0; zero internet-stand-in hits (root + delegated); provider stand-in hit from both roles; fake hub served pinned /rows; harness net_check ok + evaluator-upstream hit; manifest has BOTH `tool_network: disabled` and `model_provider_network: required` as separate keys; report comparison_keys.tool_network disabled; attempt completed + resolved | wall leaking in a full run; dataset/evaluator channels accidentally walled; networks collapsed into one field | tool-network-wall.test.ts | same | wall + open channels + manifest pair |
| WRAP-1 | wrapper's default dataset id is the design-pinned Verified id (§2) | pinned-harness stand-in; no `CODEFLOW_BENCHMARK_EVAL_DATASET` | run the production `swebench-harness.sh` with stubbed python3/docker and a pre-created checkout dir | harness invocation carries `--dataset_name SWE-bench/SWE-bench_Verified`; the override env is still honored (WRAP-1b) | wrong default (`princeton-nlp/SWE-bench_Verified` today) silently grading a different dataset | swebench-harness-contract.test.ts | `bun test tests/benchmark/swebench-harness-contract.test.ts` | captured `--dataset_name` |
| WRAP-2 | constructed CLI matches the pinned commit's actual CLI (§2) | same run as WRAP-1a | inspect the captured invocation | `python3 -m swebench.harness.run_evaluation`; every flag ∈ the pinned argparse set (`-d -s -i -p --max_workers --open_file_limit -t -id --rewrite_reports --report_dir --modal`); pinned-required `--predictions_path`/`--run_id` passed; `--dataset_name` passed explicitly (pinned default is SWE-bench_Lite); `--split test`; `--instance_ids` = the one instance; int `--max_workers`/`--timeout`; cwd = the pinned-commit checkout | fabricated flags/subcommands; relying on the harness's Lite default; running from the wrong cwd breaks report discovery | swebench-harness-contract.test.ts | same | argv + cwd |
| WRAP-3 | verdict derives from the pinned report location (§9) | stand-in writes the per-instance report at `logs/run_evaluation/<run_id>/<model_name '/'→'__'>/<instance>/report.json` (model name contains a `/`) | same wrapper run | last stdout line `resolved` when the report says resolved=true | wrong path (no model-name component today) turns every completed evaluation into not_evaluated | swebench-harness-contract.test.ts | same | verdict token |
| WRAP-4 | verdict derives from the pinned report shape (§9) | stand-in writes `{"<instance_id>": {"resolved": false, …}}` (grading.get_eval_report shape) | same wrapper run | last stdout line `unresolved` when resolved=false | run-level `resolved_ids` parsing (make_run_report's artifact, a different file) can never see per-instance verdicts | swebench-harness-contract.test.ts | same | verdict token |
| WRAP-5 | harness failure classification; no fabrication, no retry (§9) | stand-in modes: exit 1 (FAIL) / completed without report (NO_REPORT) | wrapper runs | FAIL ⇒ `infra_error` with exactly ONE harness invocation; no report ⇒ `not_evaluated`; never a fabricated resolved/unresolved | infra failure disguised as unresolved; silent in-wrapper retry | swebench-harness-contract.test.ts | same | token + invocation count |
| WRAP-6 | predictions consumable per official field contract; distinct evaluation run ids (§4, §10, §13.8) | prediction missing `model_patch` (boundary); two attempts with ids from `newEvaluationRunId(…, 1|2)` | wrapper runs per attempt | unconsumable prediction ⇒ no fabricated verdict; both attempts handed distinct `--run-id`s, each grading from its own report tree | harness `run_id+instance_id` cache collision between attempts; a predictions file the pinned harness rejects graded anyway | swebench-harness-contract.test.ts | same | run-id set + per-attempt verdicts |
| WRAP-S1..S3 | static floor of the same three pins (no process deps) | the wrapper's own source text | read `swebench-harness.sh` | S1 dataset default literal is `SWE-bench/SWE-bench_Verified`; S2 report template has run_id/model/instance segments and reads `model_name_or_path`; S3 no run-level `resolved_ids`/`unresolved_ids` parsing of the per-instance report | behavioral tests alone leave the source un-pinned for hosts without python3 | swebench-harness-contract.test.ts | same | literal/regex |

Ground-truth basis for WRAP-*: SWE-bench/SWE-bench at commit
`7a21e05772954cc81471ae19d56f436cecf43c54` (fetched once at authoring time;
never inside tests) — `swebench/harness/run_evaluation.py` (`__main__`
argparse; `run_instance()` report layout), `swebench/harness/constants/__init__.py`
(`RUN_EVALUATION_LOG_DIR`, `LOG_REPORT`), `swebench/harness/grading.py`
(`get_eval_report()` per-instance shape), `swebench/harness/reporting.py`
(`make_run_report()` run-level shape, a different artifact), and
`swebench/harness/utils.py` (`get_predictions_from_file()` field checks).
`fakes/pinned-harness-logic.py` mirrors exactly these behaviors offline.

Mechanism-scope note for NET-*: the SSOT (design §4 / contract §3) fixes the
REQUIREMENT and the manifest declarations but leaves the enforcement
MECHANISM open. These tests pin the mechanism CLASS: the wall must be
delivered through the environment the production driver gives its spawned
Codeflow tree (inherited by delegated-role children via role-launcher's
`{...process.env}` spread), observable by ordinary HTTP clients (curl +
bun/undici fetch). Prompt text, manifest fields, or an in-process extension
that leaves the spawned environment untouched do not pass. A different
mechanism class requires superseding this case set — see
fakes/README.md §6.

The fake-driver script/workspaces are built at test time by
`tests/benchmark/realmode-world.ts` (real git commits become the
base_commits, so repo@base_commit is a fact, not a string comparison).

## Not covered here (explicitly)

- The official live Docker evaluator and real 500-instance dataset runs on a
  real provider network: per design §14 these remain unexecuted external
  verification on hosts that cannot run them; the process fakes pin the seam
  contract, not the official evaluator's own correctness.
- Real-mode driver internals beyond the seam (real model credentials, the
  production clone/evaluate commands): the contract's seams are what the suite
  pins; production defaults are only exercised in real runs.
- The production `repo-clone.sh` and `swebench-harness.sh` live paths (real
  git/network/Docker): only their loud-failure modes run offline
  (production-scripts.test.ts). The production `hub-fetch.ts` IS exercised
  offline against the in-process fake hub through the base-URL seams
  (fakes/README.md §5, PIN-1..4) — revision-pinned pagination, alias/short-sha
  rejection, and manifest wiring; the real huggingface.co remains unexecuted
  external verification (design §14).
- Hub resolution against the real Hub (no base-URL seams, real network):
  REAL-14/15 cover resolution through the seam fake; PIN-1..4 cover the
  production script offline; neither leaves the host.
