import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: {
    deps: { resolveDepSubpath: true },
    dts: { generator: 'tsgo', tsgo: {} },
    platform: 'neutral',
    exports: false,
    entry: {
      bridge: 'src/bridge.ts',
      'clients/index': 'src/clients/index.ts',
      'contexts/index': 'src/contexts/index.ts',
      'http-api-definition/index': 'src/http-api-definition/index.ts',
      'page-paths': 'src/page-paths.ts',
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // `hanging-process` runs alongside the default reporter and dumps any
    // open handles after the suite ends — surfaces test-side leaks (open
    // sockets, unresolved promises) that would otherwise look like a
    // mysterious vitest hang in CI.
    reporters: ['default', 'hanging-process'],
  },
})
