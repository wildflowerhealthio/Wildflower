import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite-plus'

// By path, not as `pebble-pkjs`: Vite loads a config's package imports with
// Node, which reads the package's built `default` export, not its source.
import { pkjsPack } from '../../../../global/pebble/pebble-pkjs/src/index.ts'
import base from '../../../../vite.config.base.ts'

// The watchapp's PebbleKit JS, as its own package: fhir-sync-pebble-watchapp's
// package.json is the Pebble manifest and can't list the dependencies a
// TypeScript build needs (see ../test/vite.config.ts). `vp pack` bundles
// src/index.ts and the fhir-sync-pebble-core it imports into the one ES5 file
// the Pebble SDK reads, ../src/pkjs/index.js; the wscript runs it before every
// `pebble build`.
export default defineConfig({
  ...base,
  pack: pkjsPack({
    entry: { index: 'src/index.ts' },
    outDir: '../src/pkjs',
    alwaysBundle: ['@wildflowerhealthio/fhir-sync-pebble-core'],
    es5Tsconfig: fileURLToPath(new URL('src/tsconfig.json', import.meta.url)),
  }),
  test: {
    ...base.test,
    include: ['*.test.ts'],
  },
})
