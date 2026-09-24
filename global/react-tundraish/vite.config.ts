import { defineConfig } from 'vite-plus'
import base from '../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: {
    deps: { resolveDepSubpath: true },
    dts: { generator: 'tsgo', tsgo: {} },
    platform: 'neutral',
    // The package.json "exports" field is hand-maintained so that a "source"
    // condition can sit alongside the default dist entry. Letting tsdown
    // regenerate it would overwrite that.
    exports: false,
    entry: { index: 'src/index.ts', styles: 'src/styles.ts' },
  },
  test: {
    ...base.test,
    environment: 'jsdom',
  },
})
