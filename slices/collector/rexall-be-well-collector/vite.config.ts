import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: {
    deps: { resolveDepSubpath: true },
    dts: { generator: 'tsgo', tsgo: {} },
    exports: false,
    // The package now ships a React config form alongside the pure dialect
    // schemas, so it packs for the browser (like fhir-r4-client-collector).
    platform: 'browser',
    entry: { index: 'src/index.ts' },
  },
  test: {
    ...base.test,
    // jsdom for the config-form component test; the schema-equal matcher setup
    // is still loaded for the carebook bundle tests.
    environment: 'jsdom',
    setupFiles: [
      path.join(path.dirname(fileURLToPath(import.meta.url)), '/vitest.setupSchemaEqual.ts'),
    ],
    testTimeout: 120_000,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
