import { defineConfig } from 'vite-plus'

export default defineConfig({
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
  ],
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
})
