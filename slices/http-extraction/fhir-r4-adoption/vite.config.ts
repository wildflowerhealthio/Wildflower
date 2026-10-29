import { defineConfig } from 'vite-plus'
import base, { tsgoDts } from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: {
    deps: { resolveDepSubpath: true },
    dts: tsgoDts,
    exports: false,
    platform: 'neutral',
    entry: {
      index: 'src/index.ts',
    },
  },
  test: {
    // The property suites over generated resources of every type run well
    // past the default timeout.
    testTimeout: 120_000,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
