# Roles

Each role is a Markdown file in `runtime/agents/<role>.md`. Frontmatter binds the model and delegation metadata; the body describes capability.

## Flow roles

| Role | Capability | Evidence owned elsewhere |
| --- | --- | --- |
| `planner` | Requirement framing, immutable goals, capability composition, root closure | Product/test authorship and independent execution belong to specialists |
| `architect` | Direction, reversibility, boundaries, dependencies, fitness functions | Scaffold application and implementation belong to coding work |
| `coder` | Technical surface, developer tests, implementation, diagnosis, refactoring, performance | Business assertions belong to `tester`; execution evidence belongs to `verify` |
| `tester` | Business cases, executable business tests, assertion intent, behavioral review | Developer implementation belongs to `coder`; execution evidence belongs to `verify` |
| `verify` | Fresh-process command execution, failure classification, independent evidence | Product/test authorship belongs to their owners |

## Support roles

| Role | Capability |
| --- | --- |
| `supervisor` | Named deterministic checks such as artifact presence, checksums, and patch gates |
| `title-compressor` | One-line registry titles |
| `zipper` | Internal semantic compression of oversized bash output |

Support roles remain outside goal lanes. `zipper` is invoked by the bash-compressor extension and project work stays with flow roles.

## Frontmatter

Exactly six keys are allowed:

| Field | Required | Meaning |
| --- | --- | --- |
| `description` | yes | One-line capability |
| `model` | yes | `<provider>/<model>` |
| `tools` | no | Comma-separated tool allowlist; absent means Pi defaults |
| `delegates` | no | Exact `true` grants delegation tools at depth 0 |
| `needs_project_rules` | no | `false`, `shared`, or absent for full rules |
| `goal_lane` | no | `test`, `code`, or `verify`; binds a worker to one lane session |

Worker behavior is governed by capability semantics and repository style rather than deterministic filesystem gates. Delegation tools are registered only for depth-0 planner.

`architect` intentionally has no `goal_lane`. Architecture decisions are auxiliary handoffs: delegate them without `goal_id` or `lane`, then pass the decision to the appropriate test/code/verify owner. Only those three lanes participate in a goal join.

## Context imports

A role prompt declares reference dependencies with an HTML comment directive:

```markdown
<!-- codeflow:import path="references/capabilities/planning.md" -->
```

The context extension resolves the directive before the first provider request. Imports may recurse, are de-duplicated, and remain restricted to Markdown below Codeflow `references/`. Imported documents appear in the visible `codeflow:context` manifest and body; the role does not spend tool calls locating runtime files.

## Model bindings

Edit the `model:` line to switch providers. Prompts refer to roles, never model names.
