# Learnings Inbox

A running log of non-obvious insights discovered during agent sessions. Triage into `Strategies` or a specific reference doc periodically.

_Last triaged 2026-07-04 — durable lessons were promoted to `Strategies.md`, testing- and Effect-tagged entries moved to `docs/Testing` / `docs/Effect`, and entries about removed code (Expo/React Native, Jest, the interop slice) were dropped. Git history preserves everything removed._

<!-- Append new entries below this line -->

## Vite+ 0.2 upgrade: peer deps dodge `pnpm.overrides`; every plugin-hosting package must declare `vite: catalog:`; the vitest alias line is dead

**Discovered during**: vite-plus 0.1.21 → 0.2.2 / @vitejs/plugin-react 5 → 6 upgrade
**Learning**: Three coupled traps. (1) `pnpm.overrides` rewrites regular/dev/transitive deps but **not peer resolution** — a `vite` peer (`@vitejs/plugin-react`, `@tanstack/router-plugin`, `vite-plugin-singlefile`) binds to whatever `vite` the host package's own tree provides, and with `autoInstallPeers` an unprovided peer pulls **real** `vite@8` from the registry. With `nodeLinker: hoisted` that real vite wins the root `node_modules/vite` slot and every `defineConfig`/plugin call typechecks against mismatched `Plugin`/`UserConfig` types ("Excessive stack depth", "No overload matches"). Fix: every package that hosts a vite plugin declares `"vite": "catalog:"` (the catalog aliases it to `@voidzero-dev/vite-plus-core`), same as `wildflower-tauri` always did; the `pnpm.overrides` pin still matters for regular deps like vitest's own `vite` dependency. Verify with `vp why -r vite` — real `vite@x.y.z` should have zero dependents. (2) vite-plus 0.2.x depends on **real `vitest`** — the `@voidzero-dev/vite-plus-test` alias line ended at 0.1.24, so bumping the old catalog alias to `^0.2.2` is unsatisfiable (`ERR_PNPM_NO_MATCHING_VERSION`); pin `vitest` to the version `vp --version` reports instead. (3) The core alias ships **no `vite` bin** — `"dev": "vite"` scripts only ever worked via the accidentally-installed real vite (a stale `node_modules/.bin/vite` symlink); scripts must use `vp dev` / `vp build` / `vp preview`.
**Suggested destination**: docs/Dependencies/Version Override Explanation.md (partially applied this session) / Strategies.md
