import { defineConfig } from 'vite-plus'

export default defineConfig({
  resolve: { conditions: ['source'] },
  pack: [
    {
      dts: { tsgo: true },
      exports: false,
      platform: 'neutral',
      entry: { index: 'src/index.ts' },
    },
    {
      dts: { tsgo: true },
      exports: false,
      platform: 'neutral',
      entry: { livestore: 'src/livestore.ts' },
    },
    {
      dts: { tsgo: true },
      exports: false,
      platform: 'neutral',
      entry: { 'client-layer': 'src/client-layer.ts' },
    },
    {
      dts: { tsgo: true },
      exports: false,
      platform: 'neutral',
      entry: { 'merge-config': 'src/merge-config.ts' },
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
