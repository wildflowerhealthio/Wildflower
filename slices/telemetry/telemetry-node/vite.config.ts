import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: [
    {
      deps: { resolveDepSubpath: true },
      dts: { generator: 'tsgo', tsgo: {} },
      exports: false,
      platform: 'node',
      entry: { index: 'src/index.ts' },
    },
  ],
  test: {},
})
