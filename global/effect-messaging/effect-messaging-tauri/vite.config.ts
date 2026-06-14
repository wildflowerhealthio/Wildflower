import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: {
    dts: { tsgo: true },
    platform: 'browser',
    exports: false,
    entry: { index: 'src/index.ts' },
  },
  test: {
    // Tests inject a fake emit/listen pair and never touch `window`
    // (`@tauri-apps/api/event` dereferences Tauri globals only at call
    // time), so plain node suffices — no jsdom.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
