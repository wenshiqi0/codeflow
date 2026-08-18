# Testing Capability

<!-- codeflow:import path="references/testing.md" -->
<!-- codeflow:import path="references/patterns.md" -->

Testing makes product intent observable and contestable.

Derive cases from consequence and uncertainty: normal paths, boundaries, invalid input, state transitions, cancellation, concurrency, compatibility, and failure recovery are all candidate lenses. The imported testing reference describes selection lenses.

For each case, capture:

- id and business criterion;
- initial fixture or state;
- action or input;
- expected observable result;
- boundary or risk;
- test-file mapping;
- exact runner command;
- intended signal.

Author business test code through public behavior, stable interfaces, CLI/API surfaces, or user-observable output. Prefer the repository's established layout; business tests are stylistically separate from product code and developer unit tests.

Polling and state-machine tests inject short `poll_interval` and `max_wait`
values so a focused run completes within 30–60 seconds. After the first
unexpected timeout, run the single named test and inspect the protocol and state
transition path before extending a harness timeout.

`verify` independently owns execution evidence. If a handoff combines multiple business requirements, finish `BLOCKED` with a split request for planner.
