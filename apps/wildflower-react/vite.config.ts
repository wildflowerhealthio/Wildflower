import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'
import baseConfig from './vite.config.base.ts'

// Test-only config. The bundle builds run through `vite.config.web.ts` /
// `vite.config.single-web.ts`; this file exists so `vp test` has a default
// to load.
export default defineConfig({
  ...baseConfig,
  pack: {
    deps: { resolveDepSubpath: true },
    // `tsconfig.pack.json` drops `customConditions: ['source']` so tsgo
    // resolves workspace deps through their built `dist/*.d.ts` instead of
    // walking into each slice's `src/`. Without that override, tsgo treats
    // every transitively-imported slice source file as a project input and
    // writes `.d.ts` siblings next to them across the monorepo.
    dts: { generator: 'tsgo', tsgo: {}, tsconfig: './tsconfig.pack.json' },
    platform: 'browser',
    exports: false,
    entry: {
      'app-root': 'src/app-root.tsx',
      'web-entry': 'src/web-entry.ts',
      instrument: 'src/instrument.ts',
    },
  },
  test: {
    ...baseConfig.test,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist*/**'],
    // Stub jsdom's unimplemented `window.scrollTo` once for the whole suite so
    // TanStack Router's scroll-restoration doesn't flood the output with
    // "Not implemented" noise on every navigation. See the setup file's header.
    setupFiles: [
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'vitest.setupScrollTo.ts'),
    ],
  },
})
