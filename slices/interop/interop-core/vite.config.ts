import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: {
    dts: { tsgo: true },
    exports: false,
    platform: 'neutral',
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
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
