# Coder Preferences

These are the default coding preferences for the Codeflow coder role.

## Separated test trees

Keep tests out of source directories. Production code and tests are different lifecycle surfaces: do not mix them in the same directory.

- Business tests: `tests/biz/<goal-id>/`
- New developer unit tests: `tests/unit/`
- Goal fixtures: `tests/fixtures/<goal-id>/`

Do not place test files beside production files. Do not add `*.test.*`, `*.spec.*`, or test helper modules to `src/` or another production tree.

Business tests and developer unit tests are separate. Business tests lock observable product behavior and are owned by `test-writer`. Unit tests lock focused code behavior, are coder-owned, and are written immediately before the smallest implementation that makes them pass.

If the repository already has a different top-level test root such as `test/`, preserve that root and create the equivalent `biz/` and `unit/` subtrees beneath it. If existing repository instructions require colocated tests, report the conflict in the handoff instead of silently violating either contract.

## Batch and unit shape

- One developer unit is one focused behavior.
- Several related unit tests usually form one batch.
- A batch is a cohesive implementation increment, not a mechanical single-test handoff.
- Use about one to two working days of implementable work as the planning reference; split earlier for risk, uncertainty, or output limits.
- Do not make one unit test one handoff by default. A single-test batch is appropriate only for an isolated trivial change.
- Group closely related tests into a small TDD cluster when that is more natural than a strict one-test cycle.
- Write the unit tests first.
- Prove RED before changing product code.
- Change a cohesive set of product files when the batch truly requires them.
- Prove GREEN before checkpointing.
- Keep mocks at module boundaries; do not mock the code under test.
- Prefer deterministic commands and small fixtures.

## Type safety

Type safety is required. Keep strict compiler settings enabled and make typecheck a normal development gate.

- In TypeScript, do not use `any` by default.
- Use `unknown` plus narrowing at boundaries such as parsed JSON, external APIs, DOM events, and untyped migration data.
- Prefer precise interfaces, generics, discriminated unions, and type guards.
- If an existing type conflict makes `any` unavoidable, document the conflict and the narrowing alternative that failed in the handoff receipt or checkpoint.
- Do not silence a type error with `@ts-ignore`, `@ts-expect-error`, or an unchecked assertion merely to finish faster; isolate and explain any necessary exception.

## Checkpoint continuity

Persist or update a machine-readable batch checkpoint after every GREEN TDD cluster. The final batch checkpoint records paths, commands, results, completed batches, and remaining batches. A later handoff continues from the checkpoint and the repository, not from remembered conversation.
