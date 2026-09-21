import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'
import baseConfig from './vite.config.base.ts'

// Test-only config. The single bundle build runs through
// `vite.config.single-web.ts` (`vite.config.web.ts` is the dev server); this
// file exists so `vp test` has a default to load. There is no `pack` block:
// the only consumer of this package, `apps/wildflower-tauri`, resolves
// `wildflower-react/*` through the `source` export condition, so a built
// `dist/` would never be resolved.
export default defineConfig({
  ...baseConfig,
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
