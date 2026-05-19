import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: [{ find: /^@\/(.*)$/, replacement: './src/$1' }],
    conditions: ['source'],
  },
  pack: {
    dts: {
      tsgo: true,
    },
    // The package.json "exports" field is hand-maintained so that a "source"
    // condition can sit alongside the default dist entry. Letting tsdown
    // regenerate it would overwrite that.
    exports: false,
    // `platform: 'neutral'` makes vp pack emit `.js` (not `.mjs`), which matters
    // for Expo consumers: jest-expo's babel transform regex matches `.js` but
    // not `.mjs`, so `.mjs` dist files break Jest in expo packages that import
    // from kitchen-sink.
    platform: 'neutral',
    entry: {
      index: 'src/index.ts',
      'auth-token': 'src/auth-token/index.ts',
      'crypto-random': 'src/crypto-random/index.ts',
      'polyfills/promise-with-resolvers': 'src/polyfills/promise-with-resolvers.ts',
      schema: 'src/schema/index.ts',
      test: 'src/test/index.ts',
      types: 'src/types/index.ts',
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
})
