import { defineConfig } from 'vite-plus'

import base from '../../vite.config.base.ts'

/**
 * This package bundles nothing itself: its build downloads the prebuilt OHIF
 * viewer pinned in `prebuilt.json` and lays `config/app-config.js` over it
 * (see `src/build.ts`). The config exists so the pin parsing, the archive
 * verification and the runtime config's basename logic run as their own
 * Vitest project, registered in the root `vite.config.ts` `test.projects`
 * list. Node environment: the code under test is filesystem, hashing and
 * string logic, not UI. `vp preview` serves `dist/` for a local look at
 * whatever the last build produced (the stub or the real viewer).
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/**/*.test.ts'],
  },
})
