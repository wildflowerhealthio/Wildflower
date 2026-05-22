import { defineConfig } from 'vite-plus'
import base from '../../vite.config.base.ts'

export default defineConfig({
  ...base,
  test: {
    // This project tests are run in jest and the test files are not compatible with vitest, so we exclude them here
    include: [],
    passWithNoTests: true,
  },
  pack: {
    dts: {
      tsgo: true,
    },
    platform: 'neutral',
    // The package.json "exports" field is hand-maintained so that a "source"
    // condition can sit alongside the default dist entry. Letting tsdown
    // regenerate it would overwrite that.
    exports: false,
    entry: {
      index: 'src/index.ts',
    },
  },
})
