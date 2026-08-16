# Engineering style

These are defaults for coherent implementation, not mechanical path rules.

## Code shape

- Make the technical surface explicit enough for tests and callers to use.
- Prefer precise types and narrow boundaries; use `unknown` plus narrowing for parsed JSON, external APIs, DOM events, and migration data.
- Keep functions cohesive and dependencies directed toward stable boundaries.
- Resolve type errors directly; isolate and explain any unavoidable suppression.
- Preserve repository formatting and lint conventions.
- Keep source, comments, fixtures, and commands printable text.

## Test organization preference

Distinguish three lifecycle surfaces:

- product behavior and runtime source;
- business tests that observe external behavior;
- developer unit tests that drive internal implementation.

Prefer business tests separate from product code and from developer unit tests. Preserve a clearer project-native layout when it already exists. Language idioms may place unit tests beside the module they exercise.

## Developer tests

Developer tests are coder-owned. Group closely related behaviors into a useful focused cluster; reserve a single-test batch for an isolated trivial change. Use TDD when a compilable seam and fast feedback reduce uncertainty. Characterization, diagnosis, refactoring, and benchmark evidence are equally valid when they match the handoff.

## Checkpoints

Persist a machine-readable checkpoint after a cohesive batch. Record mode, task, unit tests, product files, command evidence, completed work, remaining work, and next owner. Continue later work from repository state plus the checkpoint, not remembered conversation.
