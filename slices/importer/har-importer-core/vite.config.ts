import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: {
    deps: { resolveDepSubpath: true },
    dts: { generator: 'tsgo', tsgo: {} },
    exports: false,
    platform: 'neutral',
    entry: {
      index: 'src/index.ts',
      'source-file': 'src/source-file.ts',
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
