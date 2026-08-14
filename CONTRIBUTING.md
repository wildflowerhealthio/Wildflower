# Contributing to Wildflower

This guide covers general development practices for all packages in the Wildflower monorepo.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Common Commands](#common-commands)
- [Code Style and Conventions](#code-style-and-conventions)
- [Testing Guidelines](#testing-guidelines)
- [Package-Specific Guidelines](#package-specific-guidelines)

## Development Setup

### Prerequisites

- Node.js 26+ (managed via `vp env`)
- The `vp` global binary (Vite+) — install with `pnpm install -g vite-plus`, then `vp install` in the repo. The devcontainer does this automatically; see [.devcontainer/postCreateCommand.sh](./.devcontainer/postCreateCommand.sh) for the full bootstrap sequence.
- Understanding of TypeScript
- Familiarity with Effect-TS (for slice cores and shared utilities)
- Knowledge of FHIR R4 (for store-related code)

### Initial Setup

```bash
git clone <repo-url> wildflower
cd wildflower
vp install
```

`vp install` wraps the project's underlying package manager (pnpm, declared via the `packageManager` field in `package.json`) — never invoke `pnpm`, `npm`, or `yarn` directly.

## Project Structure

This is a pnpm + Vite+ workspace (a polyglot repo — TS packages plus a Cargo workspace). Top-level directories:

- **`apps/`** — User-facing applications: `marketing-website`, `medication` (the SMART-on-FHIR medication app), `github-pages` (assembles the marketing site and the medication app into the published GitHub Pages artifact), `wildflower-react` (SPA in the Tauri webview), `wildflower-tauri` (Tauri host, Rust in `src-tauri`), `wildflower-relay` (Rust tunnel relay)
- **`global/`** — Project-agnostic shared utilities, copy-pastable to other projects
- **`slices/`** — Vertical product slices (`apps`, `browser-sniffer`, `collector`, `databases`, `emr`, `gatekeeper`, `navigation`, `persistence`, `scopes`, `shared-structures`, `telemetry`, `tunnel`). Each is a `<name>-core` plus optional platform adapters (`-react`, `-rust`, `-tauri`/`-tauri-rust`, `-node`, `-web`); a few are Rust-only
- **`plugins/`** — Tauri plugins (`tauri-plugin-native-webview`)
- **`scripts/`** — Shared check/build scripts (e.g. `scripts/checks/rust.sh`)
- **`patches/`** — pnpm patch files applied via `pnpm.patchedDependencies`
- **`docs/`** — Project documentation ([four-kinds convention](./docs/Documentation/Explanation.md))

Package versions are governed by the pnpm workspace catalog in `pnpm-workspace.yaml` (which is authoritative for workspace membership — the npm `workspaces` field in `package.json` is not used).

See [slices/AGENTS.md](./slices/AGENTS.md) for the slice layering rules.

## Common Commands

All workflow runs through `vp`:

```bash
vp run dev           # Start EVERY package's dev server in parallel (not just marketing-website)
vp run ready         # fmt + lint + lint:comments + lint:docs + pack + test:all — full pre-PR check
vp test              # Run Vitest across all packages (Vitest projects mode wired in root vite.config.ts)
vp run test:all      # Run the full Vitest test pass
vp run pack          # Build the monorepo (no root `build` script exists)
vp check             # Format + lint + typecheck
vp install           # Install/sync dependencies
vp fmt               # Format with Oxfmt
vp lint              # Lint with Oxlint (add --type-aware for type-aware rules)
```

All packages use Vitest via Vite+. Run `vp test` from the workspace root (Vitest projects mode honors per-package configs) or from any package directory; `vp run test:all` runs the full Vitest pass.

For the full Vite+ command surface and pitfalls, see the Vite+ block at the bottom of [AGENTS.md](./AGENTS.md).

## Code Style and Conventions

### TypeScript

- **Strict mode enabled**: All packages use TypeScript strict mode
- **Explicit parameter types**: Always type function parameters
- **Infer return types**: Let TypeScript infer return types when obvious
- **Use Effect Schema**: For runtime validation in cross-slice and slice-core packages
- **No `any` / `@ts-ignore` / `@ts-expect-error` / unsafe casts** — see [AGENTS.md](./AGENTS.md) for the narrow exceptions

### Formatting

`vp fmt` runs Oxfmt with project defaults. Run before committing.

### Naming Conventions

- **PascalCase**: Types, interfaces, classes, React components, Effect Tags
- **camelCase**: Variables, functions, properties
- **PascalCase for files**: Component files (`NavHeader.tsx`)
- **camelCase for files**: Utility files (`clientRuntime.tsx`)

### Import Organization

Order imports as follows:

1. React and React-related libraries
2. Third-party libraries
3. Effect-TS imports
4. Workspace package imports — `global/` shared utilities and other slices' packages, imported by bare package name (e.g. `collector-registry/http-api-definition`)
5. Current slice's `-core` imports
6. Local utility imports
7. Relative imports
8. Type imports (if using `import type`)

### Test imports

Always import test utilities from `vite-plus/test`, not `vitest`:

```ts
import { describe, expect, it } from 'vite-plus/test'
```

## Testing Guidelines

For comprehensive testing documentation, see [docs/Testing/](./docs/Testing/Testing%20Reference.md).

- [Unit Testing How-To](./docs/Testing/Unit%20Testing%20How-To.md) — Case-based tests, Effect patterns, FHIR schemas
- [Property Testing Reference](./docs/Testing/Property%20Testing%20Reference.md) — Arbitraries, verified mocks, MECE assertions
- [React Testing Reference](./docs/Testing/React%20Testing%20Reference.md) — Components, hooks, mocking
- [Integration Testing How-To](./docs/Testing/Integration%20Testing%20How-To.md) — VCR-style HTTP record/playback

### Quick Summary

- Use **Vitest via Vite+** for all packages. Run `vp test` from the workspace root (Vitest projects mode honors per-package configs) or from any package directory.
- `vp run test:all` runs the full Vitest pass
- Test files alongside source: `*.test.ts`
- **Property-based testing first** with `fast-check` and `Arbitrary.make(Schema)`

## Package-Specific Guidelines

Each top-level directory has its own `AGENTS.md` covering scope and rules:

- [apps/AGENTS.md](./apps/AGENTS.md) — Apps compose slice packages; no business logic
- [global/AGENTS.md](./global/AGENTS.md) — Project-agnostic utilities; no Wildflower-specific assumptions
- [slices/AGENTS.md](./slices/AGENTS.md) — Slice layering: `-core` is pure, platform adapters depend on `-core`

## Effect-TS Patterns

See [Effect Patterns Reference](./docs/Effect/Patterns%20Reference.md) for repository pattern, generators, error wrappers, and Layer composition.

## Dependency Management

### Adding Dependencies

1. Run `vp add <package>` from the relevant package directory
2. Use workspace references for internal dependencies
3. Keep dependencies minimal
4. Avoid version conflicts across packages

Dependency versions are governed by the pnpm **catalog** in `pnpm-workspace.yaml` (`catalogMode: prefer`) plus `pnpm.overrides` in the root `package.json`. Prefer `catalog:` references so a version is pinned in one place. See [Version Override Explanation](./docs/Dependencies/Version%20Override%20Explanation.md) for when to add or remove an override.

### Peer Dependencies

For shared libraries (React, etc.), use peer dependencies:

```json
{
  "peerDependencies": {
    "react": "^19.1.0"
  }
}
```

## Git Workflow

1. Create a feature branch named `username/description` (e.g., `ruthmarks/add-fhir-server`)
2. Make focused, incremental changes
3. Write descriptive commit messages
4. Run `vp run ready` before committing
5. Open a pull request
6. Address review feedback

### Parallel agents sharing one checkout

Run parallel agents in **separate worktrees** — one branch each, one index each — via `.devcontainer/wf-worktree.sh new <branch> [<base>]` (see [Parallel Worktrees](./CLAUDE.md#parallel-worktrees-devcontainer) in CLAUDE.md). Isolated indexes make the hazard below impossible.

If parallel workstreams do share a single checkout (and index), commit with an explicit pathspec every time: `git commit -- <your-paths>`. A bare `git add <paths> && git commit` commits the **whole index**, and `git commit -- <paths>` is the only form that restricts a commit to the listed paths. This matters because `git mv` **stages the rename immediately** (unlike content edits, which stay unstaged): a concurrent workstream's already-staged renames ride along in your commit even though you added no path under them. The committed tree then holds renamed files whose `mod` declarations — unstaged content edits — never made it in, so `HEAD` doesn't compile. The tell is renames from a crate you never touched showing up in your commit's file stat.

Recovery, before pushing: `git reset --soft <base>`, `git restore --staged <the-other-workstream's-paths>`, then re-commit with an explicit `git commit -- <your-paths>` pathspec.

### Git Hooks

The `prepare` script installs the hooks via `vp config`, so a plain `git commit` runs real work — don't kill one that looks "hung". The **pre-commit** hook runs `vp run pack; vp staged`, where `vp staged` maps `*` → `vp check --fix`, `*.md` → `lint:docs`, `*.{rs,toml}` → `rust.sh pre-commit`. There is **no pre-push hook** — running tests before a push is the pusher's responsibility.

`vp staged` runs its per-glob tasks concurrently and kills the survivors when one fails, so a failed commit whose summary reads `✖ Task killed: vp check --fix` names the **victim**, not the culprit. When Rust files are staged the real failure is usually `rust.sh pre-commit`'s `cargo fmt --check` printing "Diff in …" blocks further up the output; `vp check --fix` passing on its own while the commit keeps failing is the tell. Run `cargo fmt`, restage, and commit — and scroll up past the kill line for the actual diffs. Two adjacent gotchas: a standalone `vp check --fix` can reformat files after you staged them (restage before retrying), and a background `cargo check` run during a commit contends with the hook's `rust.sh` on the cargo target lock.

## CI/CD

PRs run formatting, linting, type checking, and tests. Ensure `vp run ready` passes locally before opening a PR.

## Questions?

- Check directory-level `AGENTS.md` files for layer-specific guidelines
- Consult the FHIR R4 specification for clinical data models
- Check the [Learnings Inbox](./docs/Agents/Learnings%20Inbox.md) for recent gotchas

## Summary

- **Drive everything through `vp`** — never invoke pnpm/npm/yarn directly
- **Slice cores are pure** — platform adapters depend on `-core`, never the reverse
- **Use Effect-TS** for composable, type-safe operations
- **Test thoroughly** — property-based first, with `fast-check` and `Arbitrary.make(Schema)`
- **Keep it clean** — minimal dependencies, clear separation of concerns
