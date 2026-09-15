import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: {
    dts: { tsgo: {} },
    platform: 'neutral',
    exports: false,
    entry: {
      index: 'src/index.ts',
      'smart/index': 'src/smart/index.ts',
      'connect/index': 'src/connect/index.ts',
    },
  },
  test: {
    ...base.test,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
