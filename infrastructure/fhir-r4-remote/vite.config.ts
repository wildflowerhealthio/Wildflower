import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: {
    dts: {
      tsgo: true,
    },
    exports: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
  test: {
    setupFiles: [
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../domain/fhir-r4-livestore/vitest.setupSchemaEqual.ts'
      ),
    ],
  },
})
