# Roles

Each role is a Markdown file in `runtime/agents/<role>.md`. The file *is* the role: its frontmatter binds the model and permissions, its body is the system prompt.

## Roster

| Role | Owns | Never |
| --- | --- | --- |
| `planner` | Requirement analysis, acceptance criteria, delegation, final report | Modifies product code |
| `test-writer` | Requirement-first test design; final assertion and diff review | Claims execution evidence |
| `test-runner` | Test execution and structured receipts | Edits any file |
| `coder` | Smallest coherent implementation | Redefines acceptance criteria or edits tests |
| `command` | Explicit shell, Git, and GitHub operations | Plans, delegates, or edits product code |
| `supervisor` | Deterministic mechanical checks | Explores the repository or reasons about requirements |
| `title-compressor` | One-line registry titles | Anything else; failures degrade silently |

The separation between `test-writer` and `test-runner` is the load-bearing one. The role that designs a test cannot be the role that reports whether it passed, or "the test fails for the right reason" becomes self-certified.

## Frontmatter

Exactly five keys are allowed:

| Field | Required | Meaning |
| --- | --- | --- |
| `description` | yes | One-line purpose |
| `model` | yes | `<provider>/<model>`; the single source of truth for model binding |
| `tools` | no | Comma-separated allowlist. Absent means all tools |
| `delegates` | no | Strict `true` grants `task` / `task_group`. Honored only at depth 0 |
| `needs_project_rules` | no | `false` = no rules, `shared` = shared contract only, absent = both |

Nothing else is permitted — not `temperature`, not `steps`, not `permission`. Every additional knob is a place where a role's behavior stops being explained by its prompt.

## Switching a model

Edit the one `model:` line in the role file. Provider must exist in `runtime/models.json`.

Prompts reference *roles*, never model names. A prompt that says "ask GLM to plan this" breaks the moment the binding changes, and makes the roster a fiction.

## Delegation

Only `planner` declares `delegates: true`, and it is honored only at depth 0. Delegated roles run at depth 1 and cannot delegate further.

The depth cap is not a limitation to work around. Unbounded delegation produces trees where a failure five levels down surfaces as a vague summary, and the token cost compounds while accountability dissolves. One coordinator, one layer of workers, every handoff attributable.

`task_group` runs up to 8 concurrently, but the planner is instructed to use at most 3 with disjoint file scopes. Parallel roles sharing a file produce a diff nobody authored.

A delegation returns a **pointer**, not a receipt body. The delegator reads the fields it needs from the referenced path; receipts never enter the delegator's context, which is what keeps a long run's coordinator context flat.

## Context injection

Pi runs with `--no-context-files`, so nothing loads implicitly. The `codeflow-context` extension injects a visible `<codeflow_context>` block containing the role's entitled rule layers and the run's shared facts, with a SHA-256 manifest of each source.

Visible rather than hidden in the system prompt: whatever steers a role is auditable in the transcript.

Compaction is cancelled unconditionally. A silently summarized handoff produces confident claims about work whose evidence is gone, so a role that exhausts its context fails `CONTEXT_BUDGET_EXCEEDED` instead, and the planner splits the work.

## Providers

`runtime/models.json` is the only provider configuration. All four use OpenAI-compatible completions with keys read from the environment: `ZHIPU_API_KEY`, `KIMI_API_KEY`, `MIMO_API_KEY`, `DEEPSEEK_API_KEY`.

Different roles on different models is the point of the inner loop. A cheap fast model executes tests and compresses titles; stronger models plan and implement. Verify with `scripts/doctor.sh`.
