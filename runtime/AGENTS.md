# Codeflow Runtime Development

The shared model-facing Agent contract is `../references/agent.md`. Read it
completely before changing agent behavior. Pi Agents execute assigned work;
codeteam is callable by the outer loop and Pi alike. Do not duplicate
or inject the prompt from this file.

`../docs/collaboration-semantics.md` is the normative protocol. Any change to
model-visible nouns, actions, fields, or statuses must update it and its schema
contract tests in the same change.

Keep runtime changes aligned with Pi engineering work, outer-led
asynchronous assignment and serial session reuse, Task-wide concurrency limits, Goal-scoped Commitments,
append-only Receipts, pull-first inspection, bounded model context, and evidence
under `$CODEFLOW_EVIDENCE_DIR`. Retired protocol names and compatibility paths
do not belong in the Runtime.
