import { defineConfig } from 'vite-plus'
import base from '../../vite.config.base.ts'

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
  },
  pack: {
    dts: {
      tsgo: {},
    },
    platform: 'neutral',
    exports: false,
    entry: {
      index: 'src/index.ts',
    },
  },
})
