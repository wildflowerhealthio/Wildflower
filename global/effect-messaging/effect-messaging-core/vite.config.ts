import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: {
    dts: { tsgo: true },
    exports: false,
    platform: 'neutral',
    entry: {
      index: 'src/index.ts',
      'test-platform-adapter-layer': 'src/test-platform-adapter-layer.ts',
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
