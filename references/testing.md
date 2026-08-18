# Testing capability

Testing reduces uncertainty about observable product behavior.

## Case design

Express cases as shared examples:

- initial state or fixture;
- action or input;
- observable result;
- boundary or risk being probed;
- priority and consequence of failure.

Useful lenses include boundary analysis, equivalence partitioning, state transitions, example mapping, property-based generation, error and cancellation paths, concurrency, compatibility, and accessibility. Select by risk and uncertainty rather than coverage vanity.

## Business tests

Business tests express externally meaningful contracts through public entry points, CLI/API surfaces, stable fixtures, or user-observable outputs. Keep assertions specific enough to fail for meaningful deviations and broad enough to avoid prescribing internal design.

Preferred organization keeps business tests separate from product code and developer unit tests, while preserving the repository's established layout and language idioms.

Polling and state-machine tests inject short `poll_interval` and `max_wait`
values so a focused run completes within 30–60 seconds. After the first
unexpected timeout, run the single named test and inspect the protocol and state
transition path before extending a harness timeout.

## Test index

For each handoff, record a non-empty index containing case id, criterion, fixture/input, action, expected result, test file, exact runner command, and intended signal. `verify` independently owns execution evidence.

## Review

Review the evidence story: business cases, executable assertions, verify receipts, developer tests, and diff. Look for missing boundaries, accidental implementation coupling, weakened intent, nondeterminism, and claims that exceed evidence. Route requested implementation changes to coder and interpretation conflicts to planner.
