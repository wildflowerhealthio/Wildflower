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
    entry: {
      index: 'src/index.ts',
      'crypto-random': 'src/crypto-random/index.ts',
      'polyfills/promise-with-resolvers': 'src/polyfills/promise-with-resolvers.ts',
      schema: 'src/schema/index.ts',
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
