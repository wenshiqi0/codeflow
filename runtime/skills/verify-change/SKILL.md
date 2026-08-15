---
name: verify-change
description: Independently verify a completed repository change against acceptance criteria using focused tests, regression gates, and diff inspection. Use after implementation, before declaring a task complete or handing it off for merge.
---

# Verify a Change

1. Re-read the original product acceptance criteria; do not infer success from the implementer's summary.
2. Run the focused business tests from a clean process.
3. Run focused coder-owned unit tests, then applicable lint, typecheck, broader tests, and build gates documented by the repository.
4. Inspect the checkpoint chain and final diff for missing criteria, unrelated changes, weakened business assertions, ineffective unit tests, unsafe behavior, and secrets.
5. Report `PASS`, `FAIL`, or `BLOCKED` with exact commands and concise evidence.

Do not repair product code during verification. Do not weaken tests. A blocked or failing result is valid evidence and must be returned to the planner.
