import { defineConfig } from 'vite-plus'

export default defineConfig({
  resolve: { conditions: ['source'] },
  pack: {
    dts: { tsgo: true },
    platform: 'neutral',
    exports: false,
    entry: {
      index: 'src/index.ts',
      'web-bridge': 'src/web-bridge.ts',
    },
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
