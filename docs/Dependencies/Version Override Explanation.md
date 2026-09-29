# Version Override Explanation

This project uses the pnpm `overrides:` block in [pnpm-workspace.yaml](../../pnpm-workspace.yaml) to force a single resolved version of certain packages across the workspace. This doc explains why we need them and when to add or remove one.

## What an override does

An override rewrites the version requirement of a dependency wherever it appears in the dependency graph — including transitive deps. An override of `@types/node: ^26` means every package that asks for `@types/node` will resolve it to ^26, regardless of what their `package.json` says.

This is heavier than the workspace catalog: the catalog only governs direct deps that opt in via `catalog:`, while overrides reach the whole tree.

## Why we need them

pnpm isolates packages by hashing every unique combination of peer/optional-peer dependencies. Two installs of `vite-plus@0.1.20` with different `typescript` peers become two different `.pnpm/vite-plus@0.1.20_..._<hashA>` and `.pnpm/vite-plus@0.1.20_..._<hashB>` directories with separate `node_modules` trees. Code loaded from each is a separate module instance with separate internal state.

For most tools that's fine — each package gets its own copy and they don't interact. But Vitest's projects mode loads multiple project configs into one Vitest process, and the runner relies on shared module state (the `getCurrentTask().config` lookup in `initSuite`, for example). When two projects pull different vite-plus variants, the running test sees the wrong instance and crashes with `Cannot read properties of undefined (reading 'config')`.

The same risk exists for any tool that crosses package boundaries inside a single Node process: workspace-wide linters, type checkers, codegen, dev servers that import multiple workspace packages.

## What's currently overridden

The `overrides:` block lives in [pnpm-workspace.yaml](../../pnpm-workspace.yaml).

| Package       | Pinned to  | Why                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@types/node` | `^26`      | Tracks the Node 26 `engines` floor and the workspace catalog. `@scalar/icons` (under `@scalar/api-reference`, the server-docs console) depends on `@types/node@^24`; without the override a second `@types/node` major installs beside 26, and under `nodeLinker: hoisted` either could win the root slot that TypeScript resolves for packages that don't declare their own.                                               |
| `react-dom`   | `19.3.0`   | Transitive consumers (`@tanstack/react-router`, `@dnd-kit/core`) peer-depend on bare `react-dom`, which pnpm resolves independently of the catalog. React refuses to run when `react` and `react-dom` differ at all, throwing `Incompatible React versions` at import time and failing every jsdom test file. Re-pin to match the catalog's `react` on every React bump — the catalog alone does not hold the two together. |
| `vite@*`      | `catalog:` | Managed by Vite+ (`vp migrate` writes it). Rewrites every transitive `vite` declaration to the catalog's `@voidzero-dev/vite-plus-core` alias so no real `vite@8` is installed beside it. The `@*` range is deliberate: a bare `vite` key would also match the importers' own `vite: "catalog:"` specs and cut them loose from the catalog. It follows the catalog, so a vite-plus bump needs no edit here.                 |

These overrides are what allow `vp test` from the workspace root to load all package configs into one Vitest process via `test.projects` (see [vite.config.ts](../../vite.config.ts)).

`fast-check` stays an exact `3.23.2` in the catalog, not an override: `effect` 3.x depends on `fast-check@^3.23.1`, so moving the workspace to v4 would install a second copy beside `effect`'s, and property tests that feed `Arbitrary.make` (built on `effect`'s copy) into the workspace's `fast-check` would mix two majors. Revisit when `effect` moves to fast-check 4.

## What a vite-plus bump needs from the overrides

For the full checklist of every file that records a vite-plus version — the catalog and the three global-bootstrap scripts — see the [Bumping vite-plus How-To](./Bumping%20vite-plus%20How-To.md). This section covers only why the overrides themselves need no edit.

The `vite@*` override points at `catalog:`, so it follows the catalog's `vite` alias. The alias must match the `@voidzero-dev/vite-plus-core` that the catalog's `vite-plus` itself depends on, **not** the newest core on npm. Get that wrong (or let a Dependabot bump move `vite-plus` without the alias) and `vite-plus@<new>` installs its own core next to the one the alias holds; the two `UserConfig` types then make every `defineConfig` call fail to typecheck with `TS2321: Excessive stack depth comparing types … and 'UserConfig'` (plus a companion `TS2769: No overload matches this call`).

`vitest` isn't pinned: vite-plus depends on an exact `vitest`. If a dependency ever declares a bare `vitest` range, check the lockfile for a second copy.

Diagnose in the right order: build before you lint. On an unbuilt workspace typecheck reads each package's `dist/*.d.ts` through its export map, so running `vp lint` first floods the output with `TS2307: Cannot find module '<workspace-pkg>'` that buries the real `TS2321`/`TS2769`. Run `vp run pack` first, then treat whatever survives as real.

To check for a split without a full build:

```bash
grep -oE "@voidzero-dev/vite-plus-core@[0-9.]+" pnpm-lock.yaml | sort -u   # expect exactly one line
grep -oE "^  vitest@[0-9][^(:]*" pnpm-lock.yaml | sort -u                  # expect exactly one line
```

## When to add a new override

Add one when:

1. You introduce a tool that loads multiple workspace packages in a single process and it crashes with module-state errors (`undefined.config`, broken `instanceof` checks, `Symbol(...)` mismatches).
2. `pnpm-lock.yaml` shows the tool's package resolved to two or more `(peer@vX.Y.Z)` tuples that differ on a single peer.
3. You bump a package across the monorepo and pnpm leaves a few packages on the old version because they had a different peer-dep context.

To diagnose: `readlink node_modules/<tool>` from two workspace packages and compare. Different `.pnpm/<tool>@vX_<hash>/...` paths mean different variants.

## When to remove an override

Remove one when:

1. The upstream root cause goes away. For example, if `@scalar/icons` moves to `@types/node@^26`, the `@types/node` override becomes unnecessary.
2. pnpm gains better deduplication for optional peer deps and a fresh install no longer produces variant splits without the override.
3. The catalog is bumped to the version the override pinned, and every dependent has been updated to match. At that point the override is redundant — but harmless, so removal is optional cleanup.

Periodic audit: every few releases of vite-plus / pnpm / Node, drop one override at a time, run `vp install && vp test`, and check whether the variant returns. If it does, restore the override and note the upstream cause.

## Interaction with `nodeLinker: hoisted`

The workspace sets `nodeLinker: hoisted` in [pnpm-workspace.yaml](../../pnpm-workspace.yaml), flattening node_modules npm-style. Hoisting does not reduce how many versions exist — it only decides where copies land: one version wins the root `node_modules/<pkg>` slot and conflicting versions nest under their dependents. Two consequences:

- Variant splits still happen, so overrides remain the mechanism for guaranteeing a single copy of a package across the workspace.
- Whichever version wins the root slot is what module resolution (including TypeScript's) finds first. A real `vite@8` in that slot, instead of the `@voidzero-dev/vite-plus-core` alias, breaks typechecking in every vite config. Overrides don't rewrite **peer** resolution, so each package hosting a vite plugin declares `"vite": "catalog:"` itself, making the peer bind to the alias its own tree provides. Verify no real vite crept back in with `vp why -r vite` — the real `vite@x.y.z` should have **zero** dependents once every plugin peer binds to the alias.

The `vite` alias points at `@voidzero-dev/vite-plus-core`, which ships **no `vite` binary of its own**, so there is no `node_modules/.bin/vite`. Scripts invoke the toolchain through Vite+ (`vp dev` / `vp build` / `vp preview`), never bare `vite`.

## What we don't do

- **Override every transitive package preemptively.** Overrides are friction on upstream upgrades. Add them when a real problem appears, not as a precaution.
- **Override across major versions.** All overrides above pin within the version range the catalog already declares as compatible. Bumping a package across majors via override hides the breaking change instead of addressing it.

## See Also

- [Bumping vite-plus How-To](./Bumping%20vite-plus%20How-To.md) — the checklist of every place a vite-plus version is recorded
- [pnpm overrides](https://pnpm.io/settings#overrides) — Upstream docs
- [Vitest projects](https://vitest.dev/guide/projects) — How `test.projects` loads multiple configs
- [vite.config.ts](../../vite.config.ts) — Where the projects glob is wired
- [pnpm-workspace.yaml](../../pnpm-workspace.yaml) — Catalog definitions that overrides reinforce
