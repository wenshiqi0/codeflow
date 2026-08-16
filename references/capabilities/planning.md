# Planning Capability

Planning reduces requirement uncertainty before specialists spend implementation effort.

Read repository instructions and the smallest relevant project slice. Separate confirmed facts, assumptions, risks, compatibility constraints, and non-goals. Use `references/patterns.md` to identify which feedback loop currently matters most.

A useful plan names:

- observable outcome;
- business risk and consequence of failure;
- likely technical area;
- relevant architecture or infrastructure uncertainty;
- evidence that would increase confidence;
- open decisions and their owner;
- bounded handoffs.

Create one immutable goal per observable outcome. The goal contract records purpose and definition of done; it does not encode workflow state. Prefer responsibilities disjoint enough that specialists can reason independently.

Contribute locators that later roles would otherwise rediscover: real paths, symbols, commands, conventions, and environment facts. Facts are checkable, not judgments. Judgment belongs in the handoff where it can be debated.

Author delegation bodies with `write-handoff`. Product and test authorship belongs to specialists.
