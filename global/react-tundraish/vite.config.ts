import { defineConfig } from 'vite-plus'

export default defineConfig({
  resolve: { conditions: ['source'] },
  pack: {
    dts: { tsgo: true },
    platform: 'neutral',
    // The package.json "exports" field is hand-maintained so that a "source"
    // condition can sit alongside the default dist entry. Letting tsdown
    // regenerate it would overwrite that.
    exports: false,
    entry: { index: 'src/index.ts' },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
  test: {
    environment: 'jsdom',
  },
})
