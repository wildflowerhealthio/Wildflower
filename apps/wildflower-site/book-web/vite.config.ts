import { defineConfig } from 'vite-plus'

import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  test: {
    include: ['scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/book/**'],
  },
})
