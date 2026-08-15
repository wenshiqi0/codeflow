# Directory policy

The directory-policy Pi extension intercepts `tool_call` before write, edit, or bash executes. It enforces role frontmatter and the immutable goal contract.

## Role fields

```yaml
goal_lane: test
write_policy: allow:goal
bash_policy: codeflow-only
```

### `goal_lane`

One of:

```text
test
code
verify
```

It binds the role to the matching lane of a goal's agent group.

### `write_policy`

Supported forms:

```yaml
write_policy: allow:goal
write_policy: allow:.codeflow/runs/evidence
write_policy: deny:tests/biz
write_policy: none
```

`allow:goal` resolves the lane's `write_roots` from the current immutable goal contract.

Path checks:

- resolve relative paths against the project;
- normalize `..`;
- resolve symlinks to their real paths;
- reject escapes from the repository;
- reject a symlinked root that no longer matches its contracted real path.

### `bash_policy`

Supported modes:

```text
codeflow-only
read-only
guarded-work
unrestricted
```

All modes reject obvious shell composition and redirection. Read-only references to test paths remain legitimate—for example, a verifier may run `npm test -- tests/biz/<goal-id>/`.

`bash_policy` is a pre-execution gate, not a security sandbox. A command such as `node -e` can still describe an arbitrary write. For a hard filesystem boundary, combine this extension with Pi's OS sandbox runtime.

## Current role boundaries

```text
test-writer
  writes tests/biz/<goal-id>/ and goal test evidence

coder
  writes goal code scope, tests/unit/<goal-id>/, and goal code evidence
  cannot write tests/biz/

test-runner
  writes only goal verify evidence

architect / planner / supervisor
  write only global evidence and use read-only bash
```
