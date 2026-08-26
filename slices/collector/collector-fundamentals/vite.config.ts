import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: {
    dts: { tsgo: true },
    exports: false,
    platform: 'neutral',
    entry: {
      index: 'src/index.ts',
      bridge: 'src/bridge.ts',
      'config-form': 'src/config-form.ts',
      'model/index': 'src/model/index.ts',
      'telemetry/index': 'src/telemetry/index.ts',
      'test-helpers': 'src/test-helpers.ts',
      'handler/index': 'src/handler/index.ts',
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
