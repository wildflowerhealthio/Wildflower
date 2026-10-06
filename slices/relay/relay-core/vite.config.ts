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
      'clients/index': 'src/clients/index.ts',
      'http-api-definition/index': 'src/http-api-definition/index.ts',
      'key-store/index': 'src/key-store/index.ts',
      'signing/index': 'src/signing/index.ts',
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
