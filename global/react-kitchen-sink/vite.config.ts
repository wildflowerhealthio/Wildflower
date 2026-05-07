import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
  },
  pack: {
    dts: {
      tsgo: true,
    },
    platform: 'neutral',
    exports: false,
    entry: {
      index: 'src/index.ts',
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
