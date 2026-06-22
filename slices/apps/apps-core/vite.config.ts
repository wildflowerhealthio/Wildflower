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
      'clients/index': 'src/clients/index.ts',
      'http-api-definition/index': 'src/http-api-definition/index.ts',
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
