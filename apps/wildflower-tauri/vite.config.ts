import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

const host = process.env.TAURI_DEV_HOST

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  // Match the rest of the monorepo (`vite.config.base.ts`): resolve
  // workspace imports through each package's `source` export so this app
  // consumes `wildflower-react/app-root` (and its slice deps) as TSX from
  // `src/`, not a stale `dist/`. Tauri uses plain Vite, so the base config
  // doesn't apply automatically.
  resolve: {
    conditions: ['source'],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
  },
})
