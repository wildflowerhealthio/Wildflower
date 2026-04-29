import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: {
    dts: { tsgo: true },
    platform: 'neutral',
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
})
