import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

const host = process.env.TAURI_DEV_HOST

// SINGLE SOURCE OF TRUTH: `api-origin.json` pins the loopback host/port the
// embedded API server binds to. The Rust side reads the same file in
// `src-tauri/build.rs`; injecting `WILDFLOWER_API_ORIGIN` here lets
// `src/main.tsx` derive `apiBaseUrl` from it instead of hardcoding the
// origin, so the two
// languages can't drift. Read at config-eval time (Node), baked in as a
// compile-time constant by Vite's `define`.
const apiOriginPath = fileURLToPath(new URL('./api-origin.json', import.meta.url))

const isApiOrigin = (value: unknown): value is { host: string; port: number } =>
  typeof value === 'object' &&
  value !== null &&
  'host' in value &&
  typeof value.host === 'string' &&
  'port' in value &&
  typeof value.port === 'number'

const parsedOrigin: unknown = JSON.parse(readFileSync(apiOriginPath, 'utf8'))
if (!isApiOrigin(parsedOrigin)) {
  throw new Error(
    `api-origin.json must declare string "host" and number "port" (at ${apiOriginPath})`
  )
}
const apiBaseUrl = `http://${parsedOrigin.host}:${parsedOrigin.port}`

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  // Bake the shared loopback origin in at build time so `src/main.tsx`
  // reads `WILDFLOWER_API_ORIGIN` rather than hardcoding it. Kept in sync
  // with the Rust binding via `api-origin.json` (see above).
  define: {
    WILDFLOWER_API_ORIGIN: JSON.stringify(apiBaseUrl),
  },

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
