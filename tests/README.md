# Tests

One directory per module under test. Each is independently runnable, so a
failure can be reproduced without running the rest:

```bash
bun test                    # everything
bun test tests/handoff      # one module
bun test tests/seq          # the concurrency proof, in isolation
```

A directory owns its fixtures. Anything a module's tests need lives beside
them rather than in a shared fixtures pile, so deleting a module deletes its
test surface with it.

## Layout

| Directory | Covers | Pins |
| --- | --- | --- |
| `seq/` | `lib/seq.ts` | Cross-process uniqueness of event sequence numbers |
| `facts/` | `lib/facts.ts` | The ledger: verifiable claims, append-only corrections |
| `handoff/` | `lib/handoff.ts` | State machine, receipt validation, event emission |
| `roles/` | `lib/roles.ts` | Frontmatter to pi invocation, including defaults |
| `test-patch/` | `lib/test-patch.ts` | Test-only enforcement and the post-RED lock |
| `source-safety/` | `lib/source-safety.ts` | Control-byte rejection |
| `wait/` | `lib/wait.ts` | Blocking observation, watermark, no replay |
| `liveness/` | `lib/liveness.ts` | Multi-signal probing; never DEAD from one signal |
| `context/` | `extensions/codeflow-context/context.ts` | Rule levels and fact injection |
| `handoff-gate/` | `extensions/codeflow-task/handoff-gate.ts` | Blocked-reason classification |
| `agent-watchdog/` | `extensions/agent-watchdog/index.ts` | Stream-idle abort |

## What these tests are for

They pin decisions that are cheap to break by accident and expensive to
discover at model-call time. Each test names the property it protects and,
where the reason is not obvious, why that property matters — a test that only
asserts current behaviour cannot tell a later reader whether changing it is a
bug or an improvement.

Two properties carry more weight than the rest:

- **Sequence numbers are unique across processes** (`seq/`). The outer loop
  passes the highest sequence it has seen back as `--since`, so a duplicate
  silently hides an event. The proof races real processes, not promises,
  because uniqueness has to hold across separate `pi` invocations.
- **A fact must be checkable when recorded** (`facts/`). Roles read the ledger
  without re-verifying it, so an unverifiable claim would propagate as truth.
  Rejecting the whole `handoff finish` is the loud failure that keeps it
  trustworthy.
