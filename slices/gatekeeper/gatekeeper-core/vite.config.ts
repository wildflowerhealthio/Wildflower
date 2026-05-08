import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: {
    dts: {
      tsgo: true,
    },
    platform: 'neutral',
    exports: false,
    entry: {
      'contexts/index': 'src/contexts/index.ts',
      'http-api-definition/index': 'src/http-api-definition/index.ts',
      'http-api-implementation/index': 'src/http-api-implementation/index.ts',
      'livestore/index': 'src/livestore/index.ts',
      'message-schemas': 'src/message-schemas.ts',
      'page-paths': 'src/page-paths.ts',
    },
  },
  fmt: {},
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
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
