import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite-plus'

import base from '../../../vite.config.base.ts'
import { checkEs5Library, lowerToEs5 } from './es5.ts'

// The watchapp's PebbleKit JS, as its own package: apps/fhir-sync-pebble's
// package.json is the Pebble manifest and can't list the dependencies a
// TypeScript build needs (see ../test/vite.config.ts). `vp pack` bundles
// src/index.ts and the fhir-sync-pebble-core it imports into the one ES5 file
// the Pebble SDK reads, ../src/pkjs/index.js; the wscript runs it before every
// `pebble build`.
export default defineConfig({
  ...base,
  pack: {
    entry: { index: 'src/index.ts' },
    outDir: '../src/pkjs',
    // The Pebble SDK's webpack wraps the file as a module of its own.
    format: 'iife',
    outputOptions: { entryFileNames: '[name].js' },
    // Bundle fhir-sync-pebble-core from source, as the workspace resolves it.
    inputOptions: { resolve: { conditionNames: ['source', 'import', 'default'] } },
    platform: 'neutral',
    // TypeScript lowers the whole bundle to ES5 in generateBundle; oxc stops at
    // ES2015 and would lower some syntax with helpers ES5 lacks.
    target: false,
    dts: false,
    exports: false,
    clean: false,
    hash: false,
    deps: { resolveDepSubpath: true, alwaysBundle: ['fhir-sync-pebble-core'] },
    plugins: [
      {
        name: 'fhir-sync-pebble:es5',
        // The last hook before the file is written: rolldown reprints the
        // code renderChunk returns, restoring ES2015 shorthand.
        generateBundle: (_, bundle) => {
          for (const output of Object.values(bundle)) {
            if (output.type === 'chunk') {
              checkEs5Library(
                fileURLToPath(new URL('src/tsconfig.json', import.meta.url)),
                output.moduleIds
              )
              output.code = lowerToEs5(output.code)
            }
          }
        },
      },
    ],
  },
  test: {
    ...base.test,
    include: ['*.test.ts'],
  },
})
