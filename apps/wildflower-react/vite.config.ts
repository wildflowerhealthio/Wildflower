import { defineConfig } from 'vite-plus'
import baseConfig from './vite.config.base.ts'

// Test-only config. The bundle builds run through `vite.config.web.ts` /
// `vite.config.embedded.ts`; this file exists so `vp test` has a default
// to load.
export default defineConfig({
  ...baseConfig,
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist*/**'],
  },
})
