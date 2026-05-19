import { defineConfig } from 'vite-plus'

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  pack: {
    dts: { tsgo: true },
    platform: 'neutral',
    exports: false,
    entry: { index: 'src/index.ts' },
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
