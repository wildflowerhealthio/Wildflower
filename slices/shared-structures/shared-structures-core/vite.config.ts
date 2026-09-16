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
      'http-api-definition/index': 'src/http-api-definition/index.ts',
      'http-api-implementation/index': 'src/http-api-implementation/index.ts',
      'openapi-drift/index': 'src/openapi-drift/index.ts',
      'openapi-drift/testing': 'src/openapi-drift/testing.ts',
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
