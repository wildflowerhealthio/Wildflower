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

The `overrides:` block lives in [pnpm-workspace.yaml](../../pnpm-workspace.yaml) (Vite+'s `vp migrate` moved it there from the root `package.json`).

| Package       | Pinned to  | Why                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@types/node` | `^26`      | Tracks the Node 26 `engines` floor and the workspace catalog. `@scalar/icons` (under `@scalar/api-reference`, the server-docs console) depends on `@types/node@^24`; without the override a second `@types/node` major installs beside 26, and under `nodeLinker: hoisted` either could win the root slot that TypeScript resolves for packages that don't declare their own.                                               |
| `react-dom`   | `19.3.0`   | Transitive consumers (`@tanstack/react-router`, `@dnd-kit/core`) peer-depend on bare `react-dom`, which pnpm resolves independently of the catalog. React refuses to run when `react` and `react-dom` differ at all, throwing `Incompatible React versions` at import time and failing every jsdom test file. Re-pin to match the catalog's `react` on every React bump — the catalog alone does not hold the two together. |
| `vite@*`      | `catalog:` | Managed by Vite+ (`vp migrate` writes it). Rewrites every transitive `vite` declaration to the catalog's `@voidzero-dev/vite-plus-core` alias so no real `vite@8` is installed beside it. The `@*` range is deliberate: a bare `vite` key would also match the importers' own `vite: "catalog:"` specs and cut them loose from the catalog. It follows the catalog, so a vite-plus bump needs no edit here.                 |

These overrides are what allow `vp test` from the workspace root to load all package configs into one Vitest process via `test.projects` (see [vite.config.ts](../../vite.config.ts)).

### Pins removed, and why they could go

Recorded so the next audit doesn't re-add them for reasons that no longer apply.

| Package                            | Was pinned to    | Why it existed                                                                                                                                                                                                                                                                              | Why it could go                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect`, every `@effect/*`        | `3.21.4`, …      | Added in #31 with the Expo/React Native + livestore 0.4 stack, together with `patches/effect@3.21.4.patch`: on livestore startup, Hermes/Babel-transformed generator functions failed effect's `u.constructor === genConstructor` check in `isGeneratorFunction`, and the patch relaxed it. | Expo/React Native went in #252 and livestore in #331; no expo, react-native, hermes or metro dependency remains (Expo only survives as an unused optional peer of `isomorphic-webcrypto`), so the patch did nothing after #252. The pins sat _below_ the catalog, so every catalog bump was inert. |
| `@standard-schema/spec`            | `1.1.0`          | `@livestore/peer-deps` needed it.                                                                                                                                                                                                                                                           | livestore is gone; `effect` (`^1.0.0`) resolves 1.1.0 on its own.                                                                                                                                                                                                                                  |
| `@opentelemetry/api`, `/resources` | `1.9.0`, `2.2.0` | Sentry pulled `@opentelemetry/api@1.9.1` while the catalog said 1.9.0.                                                                                                                                                                                                                      | The catalog is now 1.9.1 / 2.11.0, so the pins held the tree below its own catalog. The one other `api` copy is 1.9.0 nested under `ai` (which pins it exactly) inside `@scalar/api-reference` — a leaf dependency, not a peer, so nothing splits into variants.                                   |
| `typescript`                       | `5.9.3`          | Kept `typescript-eslint` from pulling a TypeScript outside its peer range; later it also silently outranked Dependabot's catalog bump to 7.0.2.                                                                                                                                             | The catalog itself is back on 5.9.3 (see the comment there — the npm `typescript` 7 package is the Go port with no JS compiler API, and `typescript-eslint` peers on `<6.1.0`), and every consumer resolves that one version without an override. Dependabot ignores `typescript` majors.          |

`fast-check` stays an exact `3.23.2` in the catalog, not an override: `effect` 3.x depends on `fast-check@^3.23.1`, so moving the workspace to v4 would install a second copy beside `effect`'s, and property tests that feed `Arbitrary.make` (built on `effect`'s copy) into the workspace's `fast-check` would mix two majors. Revisit when `effect` moves to fast-check 4.

## Re-pinning on a vite-plus bump

For the full checklist of every file that records a vite-plus version — the catalog, these overrides, and the three global-bootstrap scripts — see the [Bumping vite-plus How-To](./Bumping%20vite-plus%20How-To.md). This section covers only _why_ the `vite`/`vitest` overrides need re-pinning.

The `vite` and `vitest` overrides are pinned to exact versions that track `vite-plus`, so **both must be re-pinned whenever the catalog's `vite-plus` moves** — a Dependabot bump touches only the catalog and will leave them behind. When that happens, `vite-plus@<new>` installs its own `@voidzero-dev/vite-plus-core` next to the older one the override still holds, and the resulting two `UserConfig` types make every `defineConfig` call fail to typecheck with `TS2321: Excessive stack depth comparing types … and 'UserConfig'` (plus a companion `TS2769: No overload matches this call`).

Widening the catalog range does not help — an exact override outranks it, so `vp install` reports `Lockfile is up to date, resolution step is skipped` and nothing moves. Edit the override in [pnpm-workspace.yaml](../../pnpm-workspace.yaml).

Diagnose in the right order: build before you lint. On an unbuilt workspace typecheck reads each package's `dist/*.d.ts` through its export map, so running `vp lint` first floods the output with `TS2307: Cannot find module '<workspace-pkg>'` that buries the real `TS2321`/`TS2769`. Run `vp run pack` first, then treat whatever survives as real.

To check for the split without a full build:

```bash
grep -oE "@voidzero-dev/vite-plus-core@[0-9.]+" pnpm-lock.yaml | sort -u   # expect exactly one line
```

Read `vitest`'s target from the `vp --version` output rather than guessing it. Pin the **plain `vitest` package**, not an alias: the `@voidzero-dev/vite-plus-test` alias line ended at `0.1.24`, so pointing the override or catalog at a newer `@voidzero-dev/vite-plus-test` release is unsatisfiable and `vp install` fails with `ERR_PNPM_NO_MATCHING_VERSION` — vite-plus depends on real `vitest`.

Read `vite`'s target the same way: it must match the `@voidzero-dev/vite-plus-core` that the catalog's `vite-plus` itself depends on, **not** the newest core on npm. Pinning the override one patch behind that (e.g. core `0.2.8` against `vite-plus@0.2.9`) reproduces the split exactly as if it had not been re-pinned at all.

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
- Whichever version wins the root slot is what module resolution (including TypeScript's) finds first. During the vite-plus 0.2 upgrade, an auto-installed real `vite@8` won the slot over the `@voidzero-dev/vite-plus-core` alias and broke typechecking in every vite config. Overrides don't rewrite **peer** resolution, so the fix was for each package hosting a vite plugin to declare `"vite": "catalog:"` itself, making the peer bind to the alias its own tree provides. Verify no real vite crept back in with `vp why -r vite` — the real `vite@x.y.z` should have **zero** dependents once every plugin peer binds to the alias.

The `vite` override aliases to `@voidzero-dev/vite-plus-core`, which ships **no `vite` binary of its own**. A package script such as `"dev": "vite"` therefore only ever ran by accident — via a real `vite` that pnpm auto-installed as a peer, leaving a stale `node_modules/.bin/vite` symlink. Once the peers bind to the alias that symlink is gone, so scripts must invoke the toolchain through Vite+ (`vp dev` / `vp build` / `vp preview`), never bare `vite`.

## What we don't do

- **Override every transitive package preemptively.** Overrides are friction on upstream upgrades. Add them when a real problem appears, not as a precaution.
- **Override across major versions.** All overrides above pin within the version range the catalog already declares as compatible. Bumping a package across majors via override hides the breaking change instead of addressing it.

## See Also

- [Bumping vite-plus How-To](./Bumping%20vite-plus%20How-To.md) — the checklist of every place a vite-plus version is recorded
- [pnpm overrides](https://pnpm.io/settings#overrides) — Upstream docs
- [Vitest projects](https://vitest.dev/guide/projects) — How `test.projects` loads multiple configs
- [vite.config.ts](../../vite.config.ts) — Where the projects glob is wired
- [pnpm-workspace.yaml](../../pnpm-workspace.yaml) — Catalog definitions that overrides reinforce
