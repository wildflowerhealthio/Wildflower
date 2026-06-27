import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

const host = process.env.TAURI_DEV_HOST

// SINGLE SOURCE OF TRUTH: `tauri-shared-config.json` pins the loopback
// hostname/port the embedded API server binds to. The Rust side reads the same
// file in `src-tauri/build.rs`; injecting `WILDFLOWER_LOOPBACK_ORIGIN` here
// lets `src/main.tsx` derive `apiBaseUrl` from it instead of hardcoding the
// origin, so the two languages can't drift. Read at config-eval time (Node),
// baked in as a compile-time constant by Vite's `define`.
const sharedConfigPath = fileURLToPath(new URL('./tauri-shared-config.json', import.meta.url))

const isSharedConfig = (
  value: unknown
): value is {
  loopback_hostname: string
  loopback_port: number
  local_granted_scopes: string
} =>
  typeof value === 'object' &&
  value !== null &&
  'loopback_hostname' in value &&
  typeof value.loopback_hostname === 'string' &&
  'loopback_port' in value &&
  typeof value.loopback_port === 'number' &&
  'local_granted_scopes' in value &&
  typeof value.local_granted_scopes === 'string'

const parsedConfig: unknown = JSON.parse(readFileSync(sharedConfigPath, 'utf8'))
if (!isSharedConfig(parsedConfig)) {
  throw new Error(
    `tauri-shared-config.json must declare string "loopback_hostname", number "loopback_port", and string "local_granted_scopes" (at ${sharedConfigPath})`
  )
}
const apiBaseUrl = `http://${parsedConfig.loopback_hostname}:${parsedConfig.loopback_port}`
const localGrantedScopes = parsedConfig.local_granted_scopes

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  // Bake the shared loopback origin in at build time so `src/main.tsx`
  // reads `WILDFLOWER_LOOPBACK_ORIGIN` rather than hardcoding it. Kept in
  // sync with the Rust binding via `tauri-shared-config.json` (see above).
  define: {
    WILDFLOWER_LOOPBACK_ORIGIN: JSON.stringify(apiBaseUrl),
    WILDFLOWER_LOCAL_GRANTED_SCOPES: JSON.stringify(localGrantedScopes),
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
