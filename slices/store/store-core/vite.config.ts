import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: [
    {
      dts: { tsgo: true },
      exports: false,
      platform: 'neutral',
      entry: { 'contexts/index': 'src/contexts/index.ts' },
    },
    {
      dts: { tsgo: true },
      exports: false,
      platform: 'neutral',
      entry: { 'livestore/index': 'src/livestore/index.ts' },
    },
    {
      dts: { tsgo: true },
      exports: false,
      platform: 'neutral',
      entry: { 'schemas/index': 'src/schemas/index.ts' },
    },
  ],
  test: {
    setupFiles: [
      path.join(path.dirname(fileURLToPath(import.meta.url)), '/vitest.setupSchemaEqual.ts'),
    ],
    testTimeout: 30_000,
  },
})
