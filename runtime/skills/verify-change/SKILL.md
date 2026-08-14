---
name: verify-change
description: Independently verify a completed repository change against acceptance criteria using focused tests, regression gates, and diff inspection. Use after implementation, before declaring a task complete or handing it off for merge.
---

# Verify a Change

1. Re-read the original acceptance criteria; do not infer success from the implementer's summary.
2. Run the focused requirement tests from a clean process.
3. Run applicable lint, typecheck, broader tests, and build gates documented by the repository.
4. Inspect the final diff for missing criteria, unrelated changes, weakened tests, unsafe behavior, and secrets.
5. Report `PASS`, `FAIL`, or `BLOCKED` with exact commands and concise evidence.

Do not repair product code during verification. Do not weaken tests. A blocked or failing result is valid evidence and must be returned to the planner.
