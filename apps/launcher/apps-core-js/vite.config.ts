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
      'clients/index': 'src/clients/index.ts',
      'http-api-definition/index': 'src/http-api-definition/index.ts',
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
