---
name: plan-change
description: Convert a software change request into an executable, test-first plan with observable acceptance criteria and a precise agent handoff. Use when planning a feature, bug fix, refactor, migration, or other repository change before implementation begins.
---

# Plan a Change

1. Read repository instructions and inspect the affected code and tests.
2. Restate the requested outcome in observable terms. Separate confirmed facts from assumptions.
3. Define scope, non-goals, compatibility constraints, and failure risks.
4. Write business acceptance criteria that a test or deterministic check can prove from an externally meaningful input and observable result.
5. Decompose the work into goals with disjoint code scope. For each goal, identify the likely implementation area and developer batches without prescribing internal unit tests; unit tests are coder-owned, usually cover several related behaviors, and are written immediately before implementation.
6. Produce the handoff below. Do not edit product or test code.
7. Record the locators you established in your receipt's `facts` array. Exploration is most of planning's cost, and every locator you record is a search a later role does not repeat.

## Shared facts

Read the `<shared_facts>` block before exploring: on a follow-up handoff within the same run, what you need may already be there.

Record what a later role would otherwise rediscover — entry points, the module owning a behavior, test framework and layout, conventions the code enforces. Each needs a checkable locator: a real repository-relative `path` (optionally `line`), a `symbol`, or a literal `value`.

Facts are locations and conventions, not conclusions. "Route registration lives in `src/router.ts:42`" is a fact. "The router needs refactoring" is a judgment, and belongs in the handoff body where it can be argued with.

## Handoff

Author the delegation handoff with the `write-handoff` skill, which defines the business contract, Developer batch plan, goal/scope/constraints/evidence/open-questions structure and the mandatory self-check. Keep evidence to commands already executed; do not narrate the exploration process.
