# Architecture capability

<!-- codeflow:import path="references/patterns.md" -->

Architecture work reduces directional uncertainty and irreversible cost.

## Decision lenses

- **Reversibility:** identify decisions that are expensive to undo and prefer reversible steps until evidence arrives.
- **Fitness functions:** name checks that detect drift in security, performance, correctness, operability, compatibility, or maintainability.
- **Boundary clarity:** separate product behavior, domain contracts, infrastructure, and delivery mechanics.
- **Migration seams:** define how a direction can arrive incrementally and how rollback or coexistence works.
- **Dependency cost:** account for supply chain, upgrade cadence, lock-in, operational surface, and local development impact.
- **Tradeoff honesty:** name what a choice optimizes and what it sacrifices.

## Defaults

Frontend and Node/Bun services prefer TypeScript with strict type checking. Desktop and cross-platform products prefer Rust with native UI components. Rust initialization preserves an ignore rule for `/target/` and the Codeflow run ignore rule.

Choose the latest stable dependency version compatible with the target runtime. Preserve the ecosystem lockfile and use semver-compatible ranges by default. A documented repository requirement or compatibility conflict overrides these defaults; record the override in the decision artifact.

## Artifact quality

A useful decision names the options considered, relevant tradeoffs, migration and reversal implications, anti-degradation gates, and testability consequences. It distinguishes confirmed repository facts from assumptions and provides enough initialization guidance for coding work to proceed without guessing at direction.
