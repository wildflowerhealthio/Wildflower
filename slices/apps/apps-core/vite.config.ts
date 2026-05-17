import { defineConfig } from 'vite-plus'

export default defineConfig({
  resolve: { conditions: ['source'] },
  pack: {
    dts: { tsgo: true },
    exports: false,
    platform: 'neutral',
    entry: {
      index: 'src/index.ts',
      bridge: 'src/bridge.ts',
      'registry/index': 'src/registry/index.ts',
      'clients/index': 'src/clients/index.ts',
      'contexts/index': 'src/contexts/index.ts',
      'http-api-definition/index': 'src/http-api-definition/index.ts',
      'http-api-implementation/index': 'src/http-api-implementation/index.ts',
      'livestore/index': 'src/livestore/index.ts',
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
