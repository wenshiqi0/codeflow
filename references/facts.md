# Shared fact ledger

## The problem it solves

Role isolation is what makes a RED proof mean something: the process that claims a test fails is not the process that wrote it. But isolation has a bill. Every role starts blank, so the planner greps its way to `src/router.ts:42`, and then `coder` — a fresh process with no memory of any of it — greps its way there again. Multiply by five roles and the search cost rivals the work.

The ledger carries confirmed facts across the isolation boundary without carrying the context that produced them. Roles stay independent; discovery does not repeat.

## Scope: one run

The ledger lives at `.codeflow/runs/code/<run-id>/facts.jsonl` and dies with that run. It is working consensus, not durable knowledge — a fact is true of this repository at this moment, which is exactly as long as it needs to hold.

Anything worth keeping crosses runs as prose in the planner's final report, restated by the outer loop into the next requirement. That path is lossy on purpose: a fact that survives has to be worth a human-visible sentence.

## Writing

Only the CLI writes the ledger, and only as a side effect of `handoff finish` with a validated receipt:

```json
{
  "status": "PASS",
  "facts": [
    {"claim": "route registration entry", "path": "src/router.ts", "line": 42},
    {"claim": "config loader", "path": "src/config.ts", "symbol": "loadConfig"},
    {"claim": "test framework", "value": "vitest"}
  ]
}
```

There is deliberately no second write path. A tool that let a role append at will would put ledger contents on the model's honor, and the same reasoning that keeps `state.json` mechanical applies here: a fact nobody validated is worse than a fact nobody recorded, because it will be trusted.

### What is enforced

| Rule | Why |
| --- | --- |
| `claim` non-empty, ≤200 chars | Name the fact; do not narrate the process |
| A locator is required: `path`, `symbol`, or `value` | A claim nobody can check is an opinion |
| `path` must be repository-relative and exist | The CLI can verify this mechanically, so it does |
| `line` must be a positive integer | Catches off-by-default zeros |
| Unknown fields rejected | Keeps the schema from accreting `confidence` and friends |
| ≤12 facts per handoff | The ledger is useful only while it stays readable |
| Whole batch validated before any write | A bad entry cannot leave half a batch on disk |

An unverifiable fact fails the entire `handoff finish`. That is intentional: a role learns immediately, and the ledger keeps the property that makes it readable without re-verification.

## Correcting

Facts go stale mid-run — `coder` splits the module the planner located. Corrections append rather than edit:

```json
{"supersedes": "f1", "claim": "route registration entry", "path": "src/routes/index.ts", "line": 18, "reason": "router was split during implementation"}
```

The original stays in the file; readers see only the surviving view. History is preserved because *who believed what, when* is diagnostic when a run goes wrong — and because an editable ledger is one a role could quietly rewrite.

A superseding fact from the role that just touched the file outranks the original. Later roles take the correction.

## Reading

Roles never read `facts.jsonl`. The context extension renders the surviving view and injects it as a visible `<shared_facts>` block:

```text
f1: route registration entry — src/router.ts:42 [planner]
f3: test framework — vitest [tester]
```

Injection rather than file access keeps one rule intact: run artifacts are not agent input. It also means the ledger is visible in the transcript, so a human can see exactly what a role was told before it acted.

The author's role travels with each fact. It is judgeable evidence: a locator from `coder` after implementation is worth more than the same locator from before.

Facts reach every role including those that get no rule injection. A pure executor still benefits from knowing where things are, and withholding it would only push the cost back into redundant searching.

## Boundaries

- Not for secrets, file contents, or command output. Locators and short claims only.
- Not a cache of file bodies. A fact says where something is; the role reads it.
- Not durable. No cross-run inheritance, by design.
- Not for the outer loop. Reading it would mean reading run-artifact bodies, which is what the metadata plane exists to avoid.

## Trust model

Trust the locator, verify the content. A fact proves someone confirmed a path existed; it does not prove the file still has the shape you assume. Roles re-read before editing.

This is a deliberate middle ground. Trusting facts completely would let one role's mistake propagate silently through the run. Trusting them not at all would mean re-deriving everything, which is the cost the ledger exists to remove. Verifying the small thing (does this file still look right?) while trusting the expensive thing (where is it?) keeps most of the savings and bounds the damage.
