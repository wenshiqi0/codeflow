---
name: write-tests
description: Translate approved acceptance criteria into focused tests before implementation and hand exact execution commands to the test runner. Use when adding features, fixing bugs, changing behavior, or preventing regressions under a test-first process.
---

# Write Requirement-First Tests

1. Derive a short ordered target list of module/file pairs directly from the handoff. Do not narrate a full-repository analysis.
2. Process exactly one module/file pair at a time. Read only that pair's smallest affected source slice and one relevant test convention.
3. Map the current pair's acceptance criteria to assertions, then immediately use a tool to write or update only that file's unified-diff section in `.codeflow/runs/test-patches/<run-id>/tests.patch`. This is the artifact-first checkpoint; never edit repository files directly.
4. Run `code-agent check patch <patch>` as a standalone command to checkpoint that pair before reading the next pair. Preserve its SHA-256 receipt. Do not append pipes, redirects, `echo`, semicolons, or status checks. If validation fails, correct only the current pair's patch section and retry once; if it still fails, return `BLOCKED` with the exact gate error.
5. Repeat steps 2–4 for the next pair. When testing a new public module, add an ordinary integration test under the crate's `tests/` directory rather than adding any production seam to the test patch.
6. Identify the narrowest relevant command and expected failure signal. The gate permits ordinary test files and Rust changes inside an existing `#[cfg(test)] mod ...` region only and checks patched Rust files with rustfmt in an isolated worktree. Applying the patch creates a test-region lock; require `code-agent verify patch <patch>` after implementation.
7. Hand the validated patch and command to the planner; do not claim failure evidence before receiving the runner receipt. Keep the final handoff compact. Report only status, patch path, checksum, test files, command, expected failure, and acceptance-criterion mapping.

Never inspect all target modules first or postpone the patch until the end. Never batch unrelated files into one giant reasoning step. Do not interleave long explanatory analysis between tool actions; progress text must be a terse pair name and checkpoint status. If a required seam or fact is missing for the current pair, return `BLOCKED` promptly instead of exploring other modules.

When the handoff assigns an explicit file scope (parallel test generation), write only the patch sections for files in that scope and write them to the scope-specific patch path named in the handoff. Never touch other scopes' files, never read modules outside the assigned scope, and never merge sections yourself — the planner merges validated per-scope patches.

Do not implement the feature. Do not change existing expected behavior without an explicit acceptance criterion. If the patch gate rejects a required production seam, describe it and return control to the planner.
