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

- Node.js 22.12+ (managed via `vp env`)
- The `vp` global binary (Vite+) — see [README.md](./README.md) for install
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

This is a pnpm + Vite+ workspace organized into:

- **`apps/`** — User-facing applications (`website`, `wildflower-react`, `wildflower-tauri`, `wildflower-relay`)
- **`global/`** — Project-agnostic shared utilities, copy-pastable to other projects
- **`infrastructure/`** — Cross-slice infrastructure adapters (currently `fhir-r4-remote`)
- **`slices/`** — Vertical product slices (`apps`, `collector`, `gatekeeper`, `store`, `telemetry`). Each slice is a `<name>-core` plus optional platform adapters (`-web`, `-node`, `-react-native`, `-expo`)

See [slices/AGENTS.md](./slices/AGENTS.md) for the slice layering rules.

## Common Commands

All workflow runs through `vp`:

```bash
vp run dev           # Start the website dev server
vp run ready         # Format, lint, test:all (Vitest + Jest), build (-r) — full pre-PR check
vp test              # Run Vitest across all packages (Vitest projects mode wired in root vite.config.ts)
vp run jest          # Run Jest across Expo packages (vp run -r --concurrency-limit 1 jest)
vp run test:all      # Run Vitest then Jest (full test pass)
vp run build -r      # Build the monorepo
vp check             # Format + lint + typecheck
vp install           # Install/sync dependencies
vp fmt               # Format with Oxfmt
vp lint              # Lint with Oxlint (add --type-aware for type-aware rules)
```

Most packages use Vitest via Vite+. The Expo packages (`apps/wildflower`, `global/expo-effect-platform`, `global/expo-localtunnel`, `global/expo-tundraish`) run their tests through Jest with `jest-expo`, exposed as a `vp run jest` script in each package. The root `vp run jest` fans out to those packages with `--concurrency-limit 1`, and `vp run test:all` runs Vitest followed by Jest.

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
4. Cross-slice imports (`domain/`, `infrastructure/`)
5. Slice-core imports (`slices/<name>/<name>-core`)
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

- Use **Vitest via Vite+** for all packages except Expo. Run `vp test` from the workspace root (Vitest projects mode honors per-package configs) or from any package directory.
- Expo packages (`apps/wildflower`, `global/expo-*`) use **Jest with `jest-expo`** — run via `vp run jest` in the package, or `vp run jest` from the root to fan out
- `vp run test:all` runs Vitest then Jest for a complete test pass
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
