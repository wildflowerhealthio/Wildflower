import { defineConfig } from 'vite-plus'

import base from '../../../vite.config.base.ts'

// Host-side tests for the watch app's C and PebbleKit JS, as their own
// package. They can't live in apps/fhir-sync-pebble/package.json: that file is
// also the Pebble manifest, and `pebble build` runs `npm install` whenever it
// lists any dependencies or devDependencies, which fails on `catalog:` and
// `workspace:*`.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['**/*.test.ts'],
    // src/pkjs is PebbleKit JS: ES5 CommonJS, which Vitest's ESM transform
    // can't evaluate. Externalized, it goes through Node's loader, which
    // imports CommonJS natively.
    server: { deps: { external: [/\/apps\/fhir-sync-pebble\/src\/pkjs\//] } },
  },
})
