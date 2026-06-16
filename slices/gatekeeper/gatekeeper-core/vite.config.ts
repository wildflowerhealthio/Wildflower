import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: {
    dts: {
      tsgo: true,
    },
    platform: 'neutral',
    exports: false,
    entry: {
      bridge: 'src/bridge.ts',
      'clients/index': 'src/clients/index.ts',
      'contexts/index': 'src/contexts/index.ts',
      'http-api-definition/index': 'src/http-api-definition/index.ts',
      'livestore/index': 'src/livestore/index.ts',
      'page-paths': 'src/page-paths.ts',
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    // Integration suites live under `integration-tests/` and run only via
    // `vp run integration` (which uses `vite.integration.config.ts`). They
    // boot a real in-memory livestore per case, so they're slower than unit
    // tests and intentionally excluded from the default `vp test`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/integration-tests/**'],
    // `hanging-process` runs alongside the default reporter and dumps any
    // open handles after the suite ends — surfaces test-side leaks (open
    // sockets, unresolved promises) that would otherwise look like a
    // mysterious vitest hang in CI.
    reporters: ['default', 'hanging-process'],
  },
})
