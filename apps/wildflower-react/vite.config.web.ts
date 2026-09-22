import { defineConfig } from 'vite-plus'
import baseConfig from './vite.config.base.ts'

export default defineConfig({
  ...baseConfig,
  base: './',
  build: {
    outDir: 'dist-web',
    rolldownOptions: { input: 'index.html' },
  },
  // The hosted dev server binds a fixed loopback port so a running Tauri host
  // can be pointed at it (`?server=`) and the OAuth device-flow redirect URI
  // stays stable. It is pinned here rather than via `devAppServer` /
  // `slices/apps/dev-app-ports.json`: every key in that file seeds a debug-only
  // `<app>-dev` **cloud** homescreen row (`apps-rust/src/dev_seed.rs`), and the
  // hosted owner UI is deliberately NOT a homescreen app (out of scope for #696,
  // and that dev-row mechanism is being deprecated). 5195 continues the file's
  // range (…-dev ports run 5190–5194); `strictPort` fails loudly on a clash
  // instead of drifting onto another port.
  server: { host: '0.0.0.0', port: 5195, strictPort: true },
})
