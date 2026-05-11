import { defineConfig } from 'vite-plus'

export default defineConfig({
  resolve: { conditions: ['source'] },
  pack: [
    {
      dts: { tsgo: true },
      exports: false,
      platform: 'node',
      entry: { index: 'src/index.ts' },
    },
  ],
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
  test: {},
})
