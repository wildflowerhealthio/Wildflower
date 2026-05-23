import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
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
    ...base.lint,
    // The generated patient-browser asset bundle is auto-produced by
    // `scripts/generate-patient-browser.mjs` and ships a permissive
    // `eslint-disable` banner; lint passes don't apply to it.
    ignorePatterns: ['**/generated-*.ts'],
  },
  fmt: {
    ...base.fmt,
    // Same generated file: deliberately not formatted.
    ignorePatterns: ['**/generated-*.ts'],
  },
  test: {
    include: [],
    passWithNoTests: true,
  },
})
