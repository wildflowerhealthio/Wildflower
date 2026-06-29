import { defineConfig } from 'vite-plus'
import base from '../../vite.config.base.ts'

export default defineConfig({
  ...base,
  test: {
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    ...base.resolve,
    alias: [{ find: /^@\/(.*)$/, replacement: './src/$1' }],
  },
  pack: {
    dts: {
      tsgo: true,
    },
    // The package.json "exports" field is hand-maintained so that a "source"
    // condition can sit alongside the default dist entry. Letting tsdown
    // regenerate it would overwrite that.
    exports: false,
    // `platform: 'neutral'` makes vp pack emit `.js` (not `.mjs`). The
    // 'neutral' platform doesn't externalize `node:*` imports automatically,
    // so `kitchen-sink/test` (which runs under Vitest on Node) needs them
    // listed in `deps.neverBundle` — otherwise rolldown's resolver warns
    // about each `node:fs` / `node:path` import.
    platform: 'neutral',
    deps: {
      neverBundle: [/^node:/],
    },
    entry: {
      index: 'src/index.ts',
      'crypto-random': 'src/crypto-random/index.ts',
      'polyfills/promise-with-resolvers': 'src/polyfills/promise-with-resolvers.ts',
      schema: 'src/schema/index.ts',
      test: 'src/test/index.ts',
      types: 'src/types/index.ts',
    },
  },
})
