import { defineConfig } from 'vite-plus'

export default defineConfig({
  resolve: { conditions: ['source'] },
  pack: {
    dts: { tsgo: true },
    exports: false,
    platform: 'neutral',
    entry: {
      'patient-browser': 'src/patient-browser.ts',
      'http-api-definition/index': 'src/http-api-definition/index.ts',
      'http-api-implementation/index': 'src/http-api-implementation/index.ts',
    },
  },
  lint: {
    // The generated patient-browser asset bundle is auto-produced by
    // `scripts/generate-patient-browser.mjs` and ships a permissive
    // `eslint-disable` banner; lint passes don't apply to it.
    ignorePatterns: ['**/generated-*.ts'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    // Same generated file: deliberately not formatted.
    ignorePatterns: ['**/generated-*.ts'],
  },
  test: {
    include: [],
    passWithNoTests: true,
  },
})
