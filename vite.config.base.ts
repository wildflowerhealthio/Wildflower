/*
 * Two things every app's `vite.config.ts` pulls from the repo root: the shared
 * `base` config it spreads (below), and `devAppServer(id)` — the single
 * TypeScript reader of `slices/apps/dev-app-ports.json`.
 */

import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite-plus'

import devAppPortsFile from './slices/apps/dev-app-ports.json' with { type: 'json' }

/** The one non-port key in `dev-app-ports.json`; every other key is a dev app id. */
const COMMENT_KEY = '_comment'

/** The loopback host every first-party app's dev server binds to. */
const DEV_APP_HOST = '0.0.0.0'

/**
 * A dev app id declared in `slices/apps/dev-app-ports.json`.
 *
 * @remarks
 * Derived from the file, so dropping a row turns every config still naming it
 * into a type error rather than a dev-server crash.
 */
type DevAppId = Exclude<keyof typeof devAppPortsFile, typeof COMMENT_KEY>

/** Absolute path of the dev-port file, quoted in {@link devAppPort}'s error. */
const devAppPortsPath = fileURLToPath(new URL('./slices/apps/dev-app-ports.json', import.meta.url))

/**
 * Id → port. The annotation is what enforces "every value is a port number":
 * a non-number in the file fails `vp check` here, not at dev-server start.
 */
const devAppPorts: Readonly<Record<DevAppId, number>> = devAppPortsFile

/**
 * Whether `id` names a port in the file. Sound as a type guard because
 * {@link DevAppId} and `devAppPorts` come from the same import.
 */
const isDevAppId = (id: string): id is DevAppId =>
  id !== COMMENT_KEY && Object.hasOwn(devAppPorts, id)

/** Every dev app id the file declares, in declaration order. */
const devAppIds: readonly DevAppId[] = Object.keys(devAppPorts).filter(isDevAppId)

/**
 * The pinned dev-server port for `id`.
 *
 * @param id - A dev app id; anything else throws, naming the file and the ids
 *   it declares
 *
 * @remarks
 * {@link devAppServer} is what a vite config wants — it narrows `id` at compile
 * time. This one takes any string, for callers outside that narrowing.
 */
const devAppPort = (id: string): number => {
  if (!isDevAppId(id)) {
    throw new Error(
      `Unknown dev app id "${id}" — ${devAppPortsPath} declares ${devAppIds.join(', ')}`
    )
  }
  return devAppPorts[id]
}

/** Vite options pinning a first-party app's dev server to its shared port. */
interface DevAppServerOptions {
  /** The port from `slices/apps/dev-app-ports.json`. */
  readonly port: number
  /** Always `true`: a taken port fails loudly instead of drifting. */
  readonly strictPort: true
  /** The loopback host the dev server binds to. */
  readonly host: string
}

/**
 * The `server` (or `preview`) block pinning a first-party app's dev server to
 * the port `slices/apps/dev-app-ports.json` assigns it.
 *
 * @param id - The app's dev id, narrowed to the file's own keys
 * @returns Options to spread into `server` — or into `preview`, for an app
 *   whose "(Dev)" tile launches `vp preview`
 *
 * @remarks
 * `strictPort` is not optional: a server that drifted onto the next free port
 * would leave the homescreen's "(Dev)" tile launching whatever holds the
 * pinned one. See `apps/AGENTS.md` for why this is the file's only TS reader.
 *
 * @example
 * ```ts
 * export default defineConfig({ ...base, server: devAppServer('medications-app-dev') })
 * ```
 */
const devAppServer = (id: DevAppId): DevAppServerOptions => ({
  port: devAppPort(id),
  strictPort: true,
  host: DEV_APP_HOST,
})

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

export type { DevAppId, DevAppServerOptions }
export { devAppIds, devAppPort, devAppPortsPath, devAppServer }
export default base
