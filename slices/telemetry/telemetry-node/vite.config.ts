import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: [
    {
      dts: { tsgo: {} },
      exports: false,
      platform: 'node',
      entry: { index: 'src/index.ts' },
    },
  ],
  test: {},
})
