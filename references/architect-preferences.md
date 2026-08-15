# Architect Preferences

These are binding defaults for the Codeflow architect role. An explicit user requirement, an existing repository convention, or a documented compatibility conflict wins; record the override and its reason in the architecture decision artifact.

## Languages and runtimes

Frontend and Node/Bun projects prefer TypeScript. Include a strict typecheck gate from the first scaffold. Do not introduce untyped JavaScript merely for convenience.

Desktop and cross-platform projects prefer Rust. By default, render through native UI components rather than embedding a general-purpose web view. This is especially important when the product must meet computer-use accessibility/AX tree requirements: native controls expose a reliable accessibility tree to platform automation.

## Dependency version policy

When no library version is explicitly specified and there is no compatibility conflict, choose the latest stable version. Verify the version against the target runtime and existing lockfile before recommending it.

Lock the major version with semver ranges:

- npm/pnpm/Bun: caret ranges such as `^1.2.3`;
- Cargo: the default caret semantics or an explicit major-compatible requirement;
- minor and patch/hotfix updates remain allowed.

Do not pin an exact version by default. Commit or preserve the ecosystem lockfile so builds remain reproducible while permitted semver updates remain reviewable.

## Performance boundary

Measure before introducing a native performance layer. For a frontend with a clear performance requirement or a measured hotspot, use a Rust-based WebAssembly solution: implement the bounded computation in Rust, keep browser integration and rendering orchestration in TypeScript, and expose a small typed API.

Do not add WebAssembly as a default architecture choice without a performance constraint or evidence.

## Repository organization

When a product has more than one deployable surface, shared domain contracts, or a Rust/WebAssembly boundary, organize the work as a monorepo. Prefer one workspace that separates:

- frontend/application packages;
- Node/Bun services or tools;
- Rust desktop/cross-platform crates;
- Rust-to-WebAssembly crates;
- shared typed contracts and fixtures.
