import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: {
    dts: { tsgo: true },
    platform: 'browser',
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
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
