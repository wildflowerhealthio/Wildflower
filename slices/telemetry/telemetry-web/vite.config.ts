import { defineConfig } from 'vite-plus'
import base, { tsgoDts } from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: [
    {
      deps: { resolveDepSubpath: true },
      dts: tsgoDts,
      exports: false,
      platform: 'browser',
      entry: { index: 'src/index.ts' },
    },
  ],
  test: {},
})
