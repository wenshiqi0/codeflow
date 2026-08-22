# Worker registry

Codeflow separates machine policy from model instructions:

- `runtime/roles.json` binds the worker and internal support model, prompt, tool allowlist, project-rule context, and internal visibility.
- `references/capabilities/worker.md` is the one system prompt for every project worker.

## Registry entries

| Entry | Use |
| --- | --- |
| `worker` | Every project handoff; organization tools are registered by process position |
| `zipper` | Internal semantic compression of oversized Bash output |

`zipper` is internal and cannot receive a project handoff. Project workers have no identity-specific duties, models, or tool permissions.

## Schema

| Field | Required | Meaning |
| --- | --- | --- |
| `description` | yes | One-line registry description |
| `model` | yes | `<provider>/<model>` |
| `prompt` | yes | Markdown below `references/` |
| `tools` | no | Pi tool allowlist; absent means Pi defaults |
| `needs_project_rules` | no | `false`, `shared`, or `full` (default) |
| `internal` | no | Hides a support entry from project handoffs |

The loader rejects unknown fields, malformed bindings, prompts outside `references/`, and invalid context values. The organization tools are registered only for the root process position and never by a child worker.
