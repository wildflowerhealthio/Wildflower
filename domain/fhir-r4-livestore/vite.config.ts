import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: {
    dts: {
      tsgo: true,
    },
    exports: true,
    entry: {
      index: 'src/index.ts',
      'data-types/index': 'src/data-types/index.ts',
      'queries/index': 'src/queries/index.ts',
      'resources/index': 'src/resources/index.ts',
      'schema/index': 'src/schema/index.ts',
    },
  },
})
