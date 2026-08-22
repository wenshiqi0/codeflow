# Benchmark fixtures

Tiny, committed, offline. The fixture trio drives the entire benchmark chain
without network, Docker, or model calls.

- `verified-snapshot.json` — a fixed-revision local dataset snapshot. Every
  instance carries the full SWE-bench Verified field set, evaluator-only
  fields included. The `CANARY_*` strings exist **only** in evaluator-only
  fields (`patch`, `test_patch`, `FAIL_TO_PASS`, `PASS_TO_PASS`, `hints_text`,
  and the extra `assistant_notes` field on `demo/demo-1001`); if any canary
  reaches a benchmark artifact or the model-visible surface, the leakage
  contract is broken.
- `attempts.json` — the scripted fake Codeflow driver: per-instance rounds
  (usage, tool calls, simulated clock advance), failed provider attempts,
  workspace file writes, and an optional execution `infra_error`. Rounds whose
  usage omits `cache_read`/`cache_write` mean *provider did not report*, not
  zero.
- `verdicts.json` — the fake official evaluator: absent instance ⇒
  `not_evaluated`. `demo/demo-1003` is absent because its execution fails with
  an infra error before evaluation; `demo/demo-1004` is absent to exercise
  `not_evaluated`.

`demo/demo-1005` is the large-consumption target: 4 scripted rounds, each 10
minutes of simulated wall time, with 3.4M tokens in the first two rounds. Token,
round, and tool-call counts remain observational; a small `--budget
wall-seconds=...` override deterministically exercises the sole termination axis.
