import { defineConfig } from 'vite-plus'

import base from '../../../vite.config.base.ts'

// Host-side tests for the watch app's C, as their own package. They can't
// live in apps/fhir-sync-pebble/package.json: that file is also the Pebble
// manifest, and `pebble build` runs `npm install` whenever it lists any
// dependencies or devDependencies, which fails on `catalog:` and
// `workspace:*`.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['**/*.test.ts'],
  },
})
