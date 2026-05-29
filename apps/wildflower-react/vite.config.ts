import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'
import baseConfig from './vite.config.base.ts'

// Test-only config. The bundle builds run through `vite.config.web.ts` /
// `vite.config.embedded.ts`; this file exists so `vp test` has a default
// to load.
export default defineConfig({
  ...baseConfig,
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist*/**'],
    // Stub jsdom's unimplemented `window.scrollTo` once for the whole suite so
    // TanStack Router's scroll-restoration doesn't flood the output with
    // "Not implemented" noise on every navigation. See the setup file's header.
    setupFiles: [
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'vitest.setupScrollTo.ts'),
    ],
  },
})
