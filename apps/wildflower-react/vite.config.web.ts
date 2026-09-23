import { defineConfig } from 'vite-plus'
import sharedConfig from '../wildflower-tauri/tauri-shared-config.json' with { type: 'json' }
import baseConfig from './vite.config.base.ts'

// The port the debug Tauri host sends browsers to for its owner-UI pages (the
// device-flow `verification_uri`, the `/authorize` polling page, the 404 link)
// — read from the same `tauri-shared-config.json` entry, so the two can't drift.
const devPort = Number(new URL(sharedConfig.owner_ui_dev_base_url).port)

export default defineConfig({
  ...baseConfig,
  base: './',
  build: {
    outDir: 'dist-web',
    rolldownOptions: { input: 'index.html' },
  },
  // The hosted dev server binds a fixed port — `owner_ui_dev_base_url`'s, the
  // address a debug Tauri host links its owner-UI pages to — so those links land
  // here and the OAuth redirect URI stays stable. It is pinned here rather than via `devAppServer` /
  // `slices/apps/dev-app-ports.json`: every key in that file seeds a debug-only
  // `<app>-dev` **cloud** homescreen row (`apps-rust/src/dev_seed.rs`), and the
  // hosted owner UI is deliberately NOT a homescreen app (out of scope for #696,
  // and that dev-row mechanism is being deprecated). 5195 continues the file's
  // range (…-dev ports run 5190–5194); `strictPort` fails loudly on a clash
  // instead of drifting onto another port.
  server: { host: '0.0.0.0', port: devPort, strictPort: true },
})
