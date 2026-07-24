# Version Override Explanation

This project uses `pnpm.overrides` in the root `package.json` to force a single resolved version of certain packages across the workspace. This doc explains why we need them and when to add or remove one.

## What an override does

`pnpm.overrides` rewrites the version requirement of a dependency wherever it appears in the dependency graph — including transitive deps. An override of `@types/node: ^24` means every package that asks for `@types/node` will resolve it to ^24, regardless of what their `package.json` says.

This is heavier than the workspace catalog: the catalog only governs direct deps that opt in via `catalog:`, while overrides reach the whole tree.

## Why we need them

pnpm isolates packages by hashing every unique combination of peer/optional-peer dependencies. Two installs of `vite-plus@0.1.20` with different `typescript` peers become two different `.pnpm/vite-plus@0.1.20_..._<hashA>` and `.pnpm/vite-plus@0.1.20_..._<hashB>` directories with separate `node_modules` trees. Code loaded from each is a separate module instance with separate internal state.

For most tools that's fine — each package gets its own copy and they don't interact. But Vitest's projects mode loads multiple project configs into one Vitest process, and the runner relies on shared module state (the `getCurrentTask().config` lookup in `initSuite`, for example). When two projects pull different vite-plus variants, the running test sees the wrong instance and crashes with `Cannot read properties of undefined (reading 'config')`.

The same risk exists for any tool that crosses package boundaries inside a single Node process: workspace-wide linters, type checkers, codegen, dev servers that import multiple workspace packages.

## What's currently overridden

| Package              | Pinned to                                | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@types/node`        | `^24`                                    | Jest 29 (via the now-removed Expo packages) dragged in `@types/node@25.5.0` while the workspace catalog is `^24`, splitting vite-plus into two peer-tuple variants (24.12.2 and 25.5.0). Retained to keep a single `@types/node` major; re-evaluate in the next override audit now that Jest is gone.                                                                                                                                                  |
| `@opentelemetry/api` | `1.9.0`                                  | Sentry packages pull `@opentelemetry/api@1.9.1` transitively while the workspace catalog is `1.9.0`. Same variant-split problem.                                                                                                                                                                                                                                                                                                                       |
| `typescript`         | `5.9.3`                                  | The root has `typescript-eslint`, which resolves `typescript@6.0.2` from npm; workspace packages use the catalog's `^5` (5.9.3).                                                                                                                                                                                                                                                                                                                       |
| `vite`               | `npm:@voidzero-dev/vite-plus-core@0.2.5` | The catalog's `vite` alias only binds `catalog:` references. Plugins that peer-depend on bare `vite` (`@vitejs/plugin-react`, `@tanstack/router-plugin`, `vite-plugin-singlefile`) get a real `vite@8` auto-installed by pnpm's auto-install-peers, which hoists over the alias and splits `Plugin`/`UserConfig` types ("Excessive stack depth", "No overload matches" in every vite config). The override rewrites those peers to the vite-plus core. |
| `vitest`             | `4.1.10`                                 | Bare `vitest` peers otherwise auto-install whatever the registry's latest is, splitting runner state from the copy `vp test` loads (vite-plus 0.2.x depends on real vitest; the old `@voidzero-dev/vite-plus-test` alias line ended at 0.1.24). Vite+'s upgrade guide expects this pin in `pnpm.overrides`; re-pin to the version `vp --version` reports on every vite-plus bump.                                                                      |
| `@effect/workflow`   | `0.18.1`                                 | `@effect/cluster@0.58.2` declares `@effect/workflow@^0.18.0` as a peer, but pnpm's auto-install-peers picked `0.15.2`. No workspace package imports `@effect/workflow` directly, so the catalog entry never binds — the override forces the version `@effect/cluster` (and the rest of the 0.96/0.75/0.60 platform/rpc/experimental line) needs.                                                                                                       |
| `react-dom`          | `19.2.8`                                 | Transitive consumers (`@tanstack/react-router`, `@dnd-kit/core`) peer-depend on bare `react-dom`, which pnpm resolves independently of the catalog. React refuses to run when `react` and `react-dom` differ at all, throwing `Incompatible React versions` at import time and failing every jsdom test file. Re-pin to match the catalog's `react` on every React bump — the catalog alone does not hold the two together.                            |

These overrides are what allow `vp test` from the workspace root to load all package configs into one Vitest process via `test.projects` (see [vite.config.ts](../../vite.config.ts)).

## When to add a new override

Add one when:

1. You introduce a tool that loads multiple workspace packages in a single process and it crashes with module-state errors (`undefined.config`, broken `instanceof` checks, `Symbol(...)` mismatches).
2. `pnpm-lock.yaml` shows the tool's package resolved to two or more `(peer@vX.Y.Z)` tuples that differ on a single peer.
3. You bump a package across the monorepo and pnpm leaves a few packages on the old version because they had a different peer-dep context.

To diagnose: `readlink node_modules/<tool>` from two workspace packages and compare. Different `.pnpm/<tool>@vX_<hash>/...` paths mean different variants.

## When to remove an override

Remove one when:

1. The upstream root cause goes away. For example, if Sentry releases a version that uses `@opentelemetry/api@1.9.0`, the override for `@opentelemetry/api` becomes unnecessary.
2. pnpm gains better deduplication for optional peer deps and a fresh install no longer produces variant splits without the override.
3. The catalog is bumped to the version the override pinned, and every dependent has been updated to match. At that point the override is redundant — but harmless, so removal is optional cleanup.

Periodic audit: every few releases of vite-plus / pnpm / Node, drop one override at a time, run `vp install && vp test`, and check whether the variant returns. If it does, restore the override and note the upstream cause.

## Interaction with `nodeLinker: hoisted`

The workspace sets `nodeLinker: hoisted` in [pnpm-workspace.yaml](../../pnpm-workspace.yaml), flattening node_modules npm-style. Hoisting does not reduce how many versions exist — it only decides where copies land: one version wins the root `node_modules/<pkg>` slot and conflicting versions nest under their dependents. Two consequences:

- Variant splits still happen, so overrides remain the mechanism for guaranteeing a single copy of a package across the workspace.
- Whichever version wins the root slot is what module resolution (including TypeScript's) finds first. During the vite-plus 0.2 upgrade, an auto-installed real `vite@8` won the slot over the `@voidzero-dev/vite-plus-core` alias and broke typechecking in every vite config. Overrides don't rewrite **peer** resolution, so the fix was for each package hosting a vite plugin to declare `"vite": "catalog:"` itself, making the peer bind to the alias its own tree provides.

## What we don't do

- **Override every transitive package preemptively.** Overrides are friction on upstream upgrades. Add them when a real problem appears, not as a precaution.
- **Override across major versions.** All overrides above pin within the version range the catalog already declares as compatible. Bumping a package across majors via override hides the breaking change instead of addressing it.

## See Also

- [pnpm overrides](https://pnpm.io/package_json#pnpmoverrides) — Upstream docs
- [Vitest projects](https://vitest.dev/guide/projects) — How `test.projects` loads multiple configs
- [vite.config.ts](../../vite.config.ts) — Where the projects glob is wired
- [pnpm-workspace.yaml](../../pnpm-workspace.yaml) — Catalog definitions that overrides reinforce
