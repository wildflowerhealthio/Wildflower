import { defineConfig } from 'vite-plus'

export default defineConfig({
  resolve: {
    alias: [{ find: /^@\/(.*)$/, replacement: './src/$1' }],
  },
  pack: {
    dts: {
      tsgo: true,
    },
    exports: true,
    entry: {
      index: 'src/index.ts',
      schema: 'src/schema/index.ts',
      types: 'src/types/index.ts',
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
})
