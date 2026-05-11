import { defineConfig } from 'vite-plus'

export default defineConfig({
  resolve: { conditions: ['source'] },
  test: {
    // This project tests are run in jest and the test files are not compatible with vitest, so we exclude them here
    include: [],
    passWithNoTests: true,
  },
})
