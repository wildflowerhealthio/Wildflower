import { defineConfig } from 'vite-plus'

/**
 * Shared defaults every per-package `vite.config.ts` in this monorepo
 * spreads into its own config. Lives at the repo root rather than under
 * `global/` so the relative-import depth is uniform (`../...n.../
 * vite.config.base.ts`) and so accidental package-local overrides of
 * `resolve`/`ssr`/`lint`/`fmt` don't silently drop the base.
 *
 * ## What the base sets
 *
 *  - `resolve.conditions: ['source']` — resolve workspace-package
 *    imports against the package's `source` export (`./src/index.ts`)
 *    instead of its built `default` (`./dist/index.js`). Vite-plus
 *    package.json exports declare both; this keeps `vp dev`, `vp build`,
 *    and Vitest from going through the slice's dist while iterating on
 *    source.
 *  - `ssr.resolve.conditions: ['source']` — **necessary in per-package
 *    Vitest configs.** Vitest runs test modules through Vite's SSR
 *    pipeline, which has its own resolver. Without this, the SSR
 *    resolver falls back to the package's `default` export and reads
 *    the stale built dist — turning every newly-added cross-package
 *    export into a runtime `is not a function` error until somebody
 *    re-runs `vp pack` on the producer. Vitest projects mode loads
 *    each per-package config independently, so this MUST be set
 *    per-package (the root `vite.config.ts` doesn't cascade).
 *  - `lint.options: { typeAware: true, typeCheck: true }` — turns on
 *    type-aware oxlint passes uniformly. Per-package configs can add
 *    `ignorePatterns` / `rules` on top by spreading
 *    `lint: { ...base.lint, ignorePatterns: [...] }`.
 *  - `fmt: {}` — opts into the root `fmt` config for formatting.
 *
 * ## Usage
 *
 * ```ts
 * import { defineConfig } from 'vite-plus'
 * import base from '../../../vite.config.base.ts'
 *
 * export default defineConfig({
 *   ...base,
 *   pack: { ... per-package ... },
 *   test: { ... per-package ... },
 * })
 * ```
 *
 * Per-package configs that need to extend (not replace) a base key must
 * spread the base key explicitly:
 *
 * ```ts
 * export default defineConfig({
 *   ...base,
 *   resolve: { ...base.resolve, alias: [...] },          // keeps `source` condition
 *   lint: { ...base.lint, ignorePatterns: [...] },        // keeps `options`
 * })
 * ```
 */
const base = defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
  test: {
    // Node 26 exposes a global `localStorage`/`sessionStorage` (inert unless
    // `--localstorage-file` is passed). In Vitest's jsdom environment that
    // global shadows jsdom's Web Storage — Vitest skips installing jsdom's copy
    // because the key already exists on `globalThis` — so `window.localStorage`
    // reads back `undefined`. `--no-experimental-webstorage` drops Node's global
    // so jsdom installs its own. Vitest ignores `execArgv` on the root projects
    // config, so each jsdom package spreads this via `test: { ...base.test, … }`.
    execArgv: ['--no-experimental-webstorage'],
  },
})

export default base
