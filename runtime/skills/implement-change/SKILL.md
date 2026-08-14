---
name: implement-change
description: Implement an approved software change against prewritten acceptance tests using the smallest coherent diff. Use after planning and test-first evidence exist and product code must be changed to satisfy them.
---

# Implement an Approved Change

1. Read the plan, test evidence, repository instructions, and affected code.
2. If a validated test patch is supplied, apply it with `code-agent apply patch <path>`; do not transcribe or edit it manually. Reproduce the focused failing test before editing when practical.
3. Implement the smallest coherent product-code change that satisfies the acceptance criteria.
4. Preserve public behavior outside the stated scope and follow existing project conventions.
5. Run the focused tests, then relevant lint, typecheck, regression, and build commands.
6. Run `code-agent check source` to reject non-printing control bytes, then run `code-agent verify patch <path>` after implementation. Inspect the diff for unrelated edits and report files, commands, results, assumptions, and risks.

If the test and handoff disagree, stop and return the conflict to the planner.
