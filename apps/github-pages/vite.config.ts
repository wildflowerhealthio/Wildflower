import { defineConfig } from 'vite-plus'

import base from '../../vite.config.base.ts'

/**
 * This package ships no bundled app of its own — it assembles the already-built
 * sections of the published site (see `src/assembly.ts`). The config exists so
 * the layout's unit tests run as their own Vitest project, registered in the
 * root `vite.config.ts` `test.projects` list. Node environment: the code under
 * test is filesystem/path logic, not UI.
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/**/*.test.ts'],
  },
})
