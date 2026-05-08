import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    // Tests in this package run on Jest (jest-expo preset) so that
    // `react-native` + `expo-*` resolve correctly. Vitest is excluded
    // here so the workspace-level `vp test` doesn't double-run them.
    include: [],
    passWithNoTests: true,
  },
  pack: {
    dts: { tsgo: true },
    platform: 'neutral',
    exports: false,
    entry: { index: 'src/index.ts' },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
})
