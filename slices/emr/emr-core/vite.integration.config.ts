import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

// Integration-only Vitest config. Runs only files under `integration-tests/`
// (which the default `vite.config.ts` excludes from `vp test`). Invoke via
// `vp run integration` from this package, or `vp run integration` at the
// monorepo root for both packages. Filename is intentionally NOT
// `vite.config.ts` so the root `test.projects` glob doesn't pick it up
// alongside the unit config.
export default defineConfig({
  ...base,
  test: {
    include: ['integration-tests/**/*.test.ts'],
    setupFiles: [
      path.join(path.dirname(fileURLToPath(import.meta.url)), '/vitest.setupSchemaEqual.ts'),
    ],
    testTimeout: 60_000,
  },
})
