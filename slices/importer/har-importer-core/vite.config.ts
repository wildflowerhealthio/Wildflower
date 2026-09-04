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
      'har/index': 'src/har/index.ts',
      'archive/index': 'src/archive/index.ts',
      'anonymizer/index': 'src/anonymizer/index.ts',
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
