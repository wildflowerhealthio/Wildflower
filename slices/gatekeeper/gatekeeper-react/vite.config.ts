import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: {
    dts: { tsgo: true },
    platform: 'neutral',
    exports: false,
    entry: {
      index: 'src/index.ts',
      'contexts/GatekeeperWebMessageHandler': 'src/contexts/GatekeeperWebMessageHandler.ts',
      'host-token-bootstrap': 'src/host-token-bootstrap.ts',
    },
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
