---
name: write-handoff
description: Author a structured delegation handoff with verifiable acceptance criteria and a mandatory self-check before sending. Use whenever one agent delegates work to another.
---

# Write a Handoff

A handoff turns a requested outcome into a bounded, testable delegation. It is the only contract between agents, so it must be precise and self-consistent.

You write the body. The CLI records the state: `codeflow handoff open` persists your body as `handoff.md`, and the receiver reports through `codeflow handoff finish`. Never hand-write `state.json`, an event file, or an `active/` sentinel.

## Input

The requested outcome (one observable result) plus repository evidence already gathered: files inspected, commands run, and their results. Carry nothing you have not verified.

## Output

A structured artifact with exactly these sections (omit a section only when it is genuinely empty):

- Goal: one observable outcome. This line is also the registry title, so keep it under 80 characters.
- Scope: the files or components that may change, as paths. The CLI intersects these across active handoffs and warns on overlap, which is the guard rail for parallel work — vague prose here disables it.
- Out of scope: what must not change.
- Acceptance: numbered criteria.
- Constraints: compatibility, security, non-goals, environment traps.
- Initial test target: the file or module tests land in first.
- Evidence collected: commands already executed and their results. Reference `.codeflow/runs/evidence/` paths instead of pasting logs.
- Open questions: unresolved facts that can affect implementation; request that the implementer state the choice made.

## Acceptance criteria must be verifiable

Each criterion must be provable by a command or an observable artifact. Reject vague criteria by name — `works correctly`, `is robust`, `tests pass` are forbidden; instead name the input, the behavior, and the expected observable output.

## Self-check before sending

Run this check before handing off; a handoff can be internally consistent and still wrong:

1. Does any acceptance criterion contradict an existing architectural boundary? (Example: a Phase B handoff required both `bootstrap.sh` and `install.sh` to build `web/dist`. That was wrong — `install.sh` only copies the per-project `.codeflow/` runtime — and it timed out five installer tests. One wrong criterion wasted a delegation.)
2. Does any constraint contradict another constraint in this handoff?
3. Is every claim under Evidence collected actually verified by a command you ran, not assumed?

If any answer is no, fix the handoff before sending.

## Carry environment traps into Constraints

Omitting traps has produced real failures. Name them explicitly:

- A build/npm registry proxy requirement (set `HTTP_PROXY`/`HTTPS_PROXY` when a build needs the registry).
- Strip `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and their lowercase forms from test subprocesses so a developer proxy does not leak into them.
- Use a subprocess timeout above 120 seconds when a build runs, or the build times out the test.
