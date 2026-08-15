---
name: write-tests
description: Directly author observable business tests under tests/biz for one goal.
---

# Write Business Tests

Use one business requirement per handoff. If the handoff contains multiple requirements, finish `BLOCKED` with a split request.

Directly write business tests; do not create a test patch.

1. Derive one observable product behavior from the handoff.
2. Read only the smallest public entry point, fixture, or interface needed to express it.
3. Directly create or edit the focused test file under `tests/biz/<goal-id>/`.
4. Write a non-empty test-index checkpoint artifact under the goal's test evidence root containing:
   - goal id;
   - business criterion;
   - test file;
   - exact runner command;
   - intended RED signal.
5. Do not run the test as evidence. Verify lane independently owns RED/GREEN evidence.
6. Do not design coder-owned unit tests, internal seams, private functions, or implementation details.

Directory policy is part of the contract: test lane may write only `tests/biz/<goal-id>/` and its evidence root.
