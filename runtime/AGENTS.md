# Codeflow Runtime Development

The model-facing Manager contract is `../references/manager.md`; the
model-facing Worker contract is `../references/worker.md`. Read the relevant
file completely before changing agent behavior. Do not duplicate or inject
those prompts from this file.

`../docs/collaboration-semantics.md` is the normative protocol. Any change to
model-visible nouns, actions, fields, or statuses must update it and its schema
contract tests in the same change.

Keep runtime changes aligned with equal Workers, Goal-scoped Commitments,
append-only Receipts, pull-first inspection, bounded model context, and evidence
under `$CODEFLOW_EVIDENCE_DIR`. Retired protocol names and compatibility paths
do not belong in the Runtime.
