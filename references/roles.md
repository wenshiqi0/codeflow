# Roles

Codeflow separates machine policy from model instructions:

- `runtime/roles.json` is the only role registry. It binds models, prompts, tools, project-rule context, delegation permission, internal visibility, and goal lanes.
- `references/capabilities/*.md` contains the exact system prompt for each role. Runtime has no parallel agent Markdown layer.

## Flow roles

| Role | Capability | Evidence owned elsewhere |
| --- | --- | --- |
| `planner` | Behavior-level goals, specialist ownership, concise handoffs, root closure | Product, technical, architecture, and execution detail belong to specialists |
| `architect` | Direction, reversibility, boundaries, dependencies, fitness functions | Implementation and goal-lane evidence belong downstream |
| `coder` | Technical discovery, developer tests, implementation, diagnosis, evolution | Business assertions belong to `tester`; execution evidence belongs to `verify` |
| `tester` | Product contracts/SSOT, business cases, executable business tests, assertion intent | Technical implementation belongs to `coder`; execution evidence belongs to `verify` |
| `verify` | Fresh-process command execution, failure classification, independent evidence | Product and test authorship belong to their owners |

## Support roles

| Role | Capability |
| --- | --- |
| `supervisor` | Named deterministic checks such as artifact presence, checksums, and patch gates |
| `title-compressor` | One-line registry titles |
| `zipper` | Internal semantic compression of oversized Bash output |

Support roles remain outside goal lanes. `zipper` is marked `internal` and cannot receive a project handoff.

## Registry schema

Each entry in `runtime/roles.json` supports these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `description` | yes | One-line capability |
| `model` | yes | `<provider>/<model>` |
| `prompt` | yes | Markdown below `references/` |
| `tools` | no | Pi tool allowlist; absent means Pi defaults |
| `delegates` | no | Exact boolean `true` grants depth-0 delegation tools |
| `needs_project_rules` | no | `false`, `shared`, or `full` (default) |
| `goal_lane` | no | `test`, `code`, or `verify` |
| `internal` | no | Hides a support role from project handoffs |

The loader rejects unknown fields, malformed bindings, prompt paths outside `references/`, and invalid lane/context values. Delegation tools remain depth-0 only.

`architect` intentionally has no `goal_lane`. Delegate it without `goal_id` or `lane`; its decision may guide the three fixed goal-lane owners but never substitutes for their PASS evidence.

## Prompt context

The configured prompt is passed directly as the Pi system prompt. The context extension injects the role's allowed project/shared rules and the run fact ledger before work starts. A prompt may still declare a bounded `codeflow:import` below `references/`, but the production prompts are self-contained so there is no duplicated role body to merge at runtime.

To switch a provider or model, edit only the role's `model` in `runtime/roles.json`. Prompt text refers to capabilities, never model names.
