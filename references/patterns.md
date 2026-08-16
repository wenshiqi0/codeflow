# Engineering patterns

These are industry-recognized lenses for reducing uncertainty, not mandatory workflow stages. A pattern earns use when its feedback answers the current question at an acceptable cost.

## Acceptance-first

Clarifies product semantics before implementation is constrained.

Strong when business behavior, user-visible contracts, regulatory risk, or requirements ambiguity dominate. Cases become shared examples: given state, when action, then observable result. The artifact is case intent plus an executable path when automation is practical.

Weakness: heavy acceptance ceremony can slow exploratory discovery or low-risk internal refactoring.

## Test-driven development

Uses a small failing test to design a focused behavior seam.

Strong when the technical surface is stable enough to compile, feedback is fast, and the missing behavior can be observed narrowly. The useful evidence is a focused RED, a coherent minimal change, GREEN, and any refactor that stays green.

Weakness: a missing module, unresolved API, or infrastructure prerequisite produces setup noise rather than business RED. Compile failure is test-authoring or setup feedback, not a behavior observation.

## Diagnosis-first

Establishes a reproducible failure before changing code.

Strong for defects, regressions, flakes, and reported incidents. Evidence includes reproduction, affected boundary, first actionable difference, and focused repair validation.

Weakness: diagnosis without a time box can become unbounded exploration.

## Characterization

Captures current behavior before changing it.

Strong around legacy code, migrations, and undocumented invariants. The tests describe observed behavior, not necessarily desired behavior.

Weakness: characterization can legitimize defects if mistaken for a product contract.

## Baseline-preserving refactoring

Improves structure while keeping observable behavior stable.

Strong when tests establish a green baseline and the change is internally cohesive. Evidence compares before and after behavior.

Weakness: mixed feature and refactor diffs make attribution difficult.

## Benchmark-driven change

Measures before optimizing.

Strong for speed, latency, throughput, memory, scaling, and resource claims. Record environment, build mode, parameters, samples, variance, baseline, changed measurement, and correctness gates.

Weakness: microbenchmarks can overfit scenarios that do not represent production use.

## Architecture shaping

Reduces irreversible cost before a direction hardens.

Strong for runtime, dependency, service boundary, data, deployment, security, and migration choices. Compare reversibility, degradation risk, migration cost, and operational consequences.

Weakness: broad speculative architecture can delay a reversible product experiment.

## Risk-based verification

Selects depth by consequence and uncertainty.

Strong when test budgets are finite. Combine business acceptance, focused developer tests, regression, differential comparison, exploratory review, and operational checks according to failure impact.

Weakness: risk labels without evidence can hide untested assumptions.

## Pattern composition

Patterns can coexist. A greenfield effort may use architecture shaping, minimal scaffolding, acceptance cases, and TDD on selected seams. A defect may combine diagnosis-first with characterization and regression. A performance change may preserve correctness while using benchmark evidence. Reassess the active pattern when new evidence changes the dominant uncertainty.
