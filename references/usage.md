# Model usage

Codeflow attributes every assistant model response to the current Codeflow role, handoff, goal lane, and model. The zipper support model is also recorded even though it runs in an isolated no-tool child.

## Artifacts

```text
.codeflow/runs/code/<run-id>/usage.jsonl   # one append-only row per model round
.codeflow/runs/code/<run-id>/usage.json    # final aggregate report
```

Each ledger row contains:

- `at`, `run_id`, `role`, `depth`, and `handoff_id`;
- `goal_id` and `lane` for goal workers;
- `turn`;
- `provider`, `model`, and `response_model`;
- normalized input, output, cache read/write, reasoning, and total tokens;
- normalized cost breakdown.

The final report repeats every per-turn record and adds per-model totals, run-wide totals, and a generated timestamp.

The depth-0 runner writes `usage.json` after all children exit. Usage failures never change the product run's exit code; the append-only ledger remains the fallback.

## Commands

During or after a run:

```bash
codeflow usage <run-id>
```

The command returns one JSON document with `records`, `models`, and `total`. A fresh `codeflow exec` also prints a compact per-model and total summary on stderr and names the final `usage.json` path.

Benchmarks should read `usage.json` or `codeflow usage <run-id>` rather than parsing Pi sessions. Session transcripts contain provider prose and are deliberately not the observability surface.
