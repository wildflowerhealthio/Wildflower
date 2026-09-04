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
      'capture/index': 'src/capture/index.ts',
      'codec/index': 'src/codec/index.ts',
      'provenance/index': 'src/provenance/index.ts',
      'pseudonymizer/index': 'src/pseudonymizer/index.ts',
      'test-helpers': 'src/test-helpers.ts',
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
