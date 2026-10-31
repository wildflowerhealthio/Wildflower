import { defineConfig } from 'vite-plus'
import base, { tsgoDts } from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: {
    deps: { resolveDepSubpath: true },
    dts: tsgoDts,
    exports: false,
    platform: 'neutral',
    entry: {
      index: 'src/index.ts',
      'source-file': 'src/source-file.ts',
      synthesis: 'src/synthesis.ts',
      'test-helpers': 'src/test-helpers.ts',
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
