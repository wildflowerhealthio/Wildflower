import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: [
    {
      dts: { tsgo: true },
      exports: false,
      platform: 'neutral',
      entry: { 'clients/index': 'src/clients/index.ts' },
    },
    {
      dts: { tsgo: true },
      exports: false,
      platform: 'neutral',
      entry: { 'http-api-definition/index': 'src/http-api-definition/index.ts' },
    },
    {
      dts: { tsgo: true },
      exports: false,
      platform: 'neutral',
      entry: { 'resources/index': 'src/resources/index.ts' },
    },
    {
      dts: { tsgo: true },
      exports: false,
      platform: 'neutral',
      entry: { 'data-types/index': 'src/data-types/index.ts' },
    },
    {
      dts: { tsgo: true },
      exports: false,
      platform: 'neutral',
      entry: { 'http-api-implementation/index': 'src/http-api-implementation/index.ts' },
    },
  ],
  test: {
    setupFiles: [
      path.join(path.dirname(fileURLToPath(import.meta.url)), '/vitest.setupSchemaEqual.ts'),
    ],
    testTimeout: 120_000,
    // Integration suites live under `integration-tests/` and run only via
    // `vp run integration` (which uses `vite.integration.config.ts`). They
    // boot a real in-memory livestore per case, so they're slower than unit
    // tests and intentionally excluded from the default `vp test`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/integration-tests/**', '**/profile/**'],
  },
})
