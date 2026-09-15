import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: {
    dts: { tsgo: {} },
    exports: false,
    // Ships a React config form alongside the pure entities, so it packs for
    // the browser (like fhir-r4-client-collector / rexall-be-well-collector).
    platform: 'browser',
    entry: { index: 'src/index.ts' },
  },
  test: {
    ...base.test,
    // jsdom for the config-form component test.
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
