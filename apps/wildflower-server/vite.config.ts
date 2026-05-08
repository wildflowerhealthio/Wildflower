import { defineConfig } from 'vite-plus'

export default defineConfig({
  resolve: { conditions: ['source'] },
  pack: {
    dts: { tsgo: true },
    platform: 'neutral',
    exports: false,
    entry: {
      index: 'src/index.ts',
      schema: 'src/schema.ts',
      'static-spa': 'src/static-spa.ts',
    },
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
