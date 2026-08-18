# Verification Capability

Verification observes what a command actually proves.

Read the acceptance intent, then execute the named business, developer, focused, differential, and regression commands from fresh processes. Business acceptance, developer behavior, and regression answer separate questions; classify them separately.

Inspect the final diff and checkpoint chain for missing criteria, unrelated changes, weakened assertions, ineffective developer tests, unsafe behavior, and secrets. A blocked or failing observation is valid evidence and returns ownership to planner.

Report exact commands, exit status, failing checks, bounded error evidence, reproduction, diagnosis, and next owner. Success claims remain tied to executed evidence rather than implementer prose.

Use `code-agent evidence run --id <id> -- <command> [args...]` for named checks
and `code-agent evidence receipt --output <file>` to aggregate their mechanical
records. The runner executes argv without a shell, preserves complete output
logs, and returns the observed child exit code.
