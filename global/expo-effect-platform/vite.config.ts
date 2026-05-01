import { defineConfig } from 'vite-plus'

export default defineConfig({
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
    exports: false,
    entry: {
      index: 'src/index.ts',
      ExpoEffectPlatformModule: 'src/ExpoEffectPlatformModule.ts',
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
