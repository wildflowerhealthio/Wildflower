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
      entry: { 'schemas/index': 'src/schemas/index.ts' },
    },
    {
      dts: { tsgo: true },
      exports: false,
      platform: 'neutral',
      entry: { 'transform/index': 'src/transform/index.ts' },
    },
  ],
  test: {
    setupFiles: [
      path.join(path.dirname(fileURLToPath(import.meta.url)), '/vitest.setupSchemaEqual.ts'),
    ],
    testTimeout: 120_000,
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
