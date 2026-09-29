import { defineConfig } from 'vite-plus'
import base, { tsgoDts } from '../../vite.config.base.ts'

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
  },
  pack: {
    deps: { resolveDepSubpath: true },
    dts: tsgoDts,
    platform: 'neutral',
    exports: false,
    entry: {
      index: 'src/index.ts',
    },
  },
})
