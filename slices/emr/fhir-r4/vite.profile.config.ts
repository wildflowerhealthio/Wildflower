import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

// Profile-only Vitest config. Runs only files under `profile/` (which the
// default `vite.config.ts` excludes from `vp test`). Invoke via
// `vp run profile` from this package. Filename is intentionally NOT
// `vite.config.ts` so the root `test.projects` glob doesn't pick it up
// alongside the unit config.
//
// The `profile` script sets `NODE_OPTIONS='--cpu-prof'`; Vitest workers
// inherit it and emit a `.cpuprofile` per worker into `.profiles/`. With one
// profile test file there's one worker, so one profile. Open the resulting
// file in Chrome DevTools → Performance → Load Profile.
export default defineConfig({
  ...base,
  test: {
    include: ['profile/**/*.profile.test.ts'],
    setupFiles: [
      path.join(path.dirname(fileURLToPath(import.meta.url)), '/vitest.setupSchemaEqual.ts'),
    ],
    testTimeout: 600_000,
  },
})
