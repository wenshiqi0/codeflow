# Implementation Capability

<!-- codeflow:import path="references/engineering-style.md" -->
<!-- codeflow:import path="references/patterns.md" -->

Implementation converts a bounded outcome into a coherent technical surface, tests, and working code.

Select the mode that answers the handoff's dominant uncertainty:

- **scaffold-first** for a missing runnable package or build surface;
- **TDD** for a stable, compilable behavior seam where fast feedback helps;
- **diagnosis-first** for a reproducible defect;
- **characterization** for legacy behavior before migration;
- **refactoring** with a green behavioral baseline;
- **benchmark-driven optimization** after correctness and measurement are established.

The mode may change as evidence arrives. Record what was attempted and what evidence it produced.

Follow the imported engineering style. Preserve the repository's language idioms and existing conventions. Keep one handoff to a cohesive batch; continue later work from the checkpoint and repository.

Business assertions belong to `tester`; independent execution evidence belongs to `verify`. If implementation and business intent disagree, report the conflict to planner.
