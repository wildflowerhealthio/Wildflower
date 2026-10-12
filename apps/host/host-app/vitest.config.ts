import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

// Test-only config, which `vp test` picks over `vite.config.ts`. The webview
// bundle builds through `vite.config.ts`, the plain Vite config Tauri runs.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/src-tauri/**'],
  },
})
