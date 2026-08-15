---
name: implement-change
description: Implement one cohesive coder-owned TDD batch inside one goal code scope.
---

# Implement One Developer Batch

1. Read the plan, acceptance evidence, repository instructions, affected code, and the coder preference reference loaded by the coder role.
2. Type safety is required. In TypeScript, do not use `any` by default; if an existing type conflict makes `any` unavoidable, document the conflict and the narrowing alternative that failed.
3. Select one cohesive developer batch from the handoff or the latest batch checkpoint. A batch normally contains several focused unit tests and a cohesive set of product files; a single unit test is appropriate only for an isolated trivial change.
4. Decide the exact unit-test decomposition yourself. Group closely related tests into a small TDD cluster rather than mechanically finishing after one test.
5. For each cluster, always write the unit tests first under `tests/unit/<goal-id>/`; never put them in `tests/biz/` or beside production code.
6. Run the narrowest command and record an actual RED result for the cluster. If failure is not caused by missing behavior, correct those unit tests before touching product code.
7. Implement the smallest coherent change for the cluster inside the goal code scope.
8. Require GREEN for the cluster, then run the narrow relevant business probe when supplied.
9. Update the batch checkpoint after every GREEN cluster. Continue only while the work remains cohesive and below the goal's size reference.
10. Write the final batch checkpoint before finishing. Include goal id, batch intent, unit tests, product files, RED/GREEN evidence, business probes, completed work, remaining work, and next owner.
11. Finish the handoff after this one batch. The same goal code-lane session continues in the next handoff.
12. Run `code-agent check source`. Inspect the diff for unrelated edits.

Never edit business tests in `tests/biz/`. Coder-owned unit tests are editable and must remain in the diff for review. If the business contract and implementation disagree, stop and report the conflict to planner.
