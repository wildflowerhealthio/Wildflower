import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

import base, { devAppServer } from '../../../vite.config.base.ts'

/**
 * A SMART-on-FHIR app built as a static bundle into this package's default
 * `dist/`, which `.github/workflows/deploy-pages-site.yml` publishes. One HTML entry, `index.html`:
 * the standalone connect menu on a bare visit, and the OAuth redirect target
 * that completes the handshake and renders the Pebble settings page when a
 * callback is in the URL. No EHR launches it — the app is only ever opened
 * standalone, from the Pebble phone app's watchapp settings. A relative
 * `base` so the built assets resolve from whatever origin / path the bundle is
 * served at: its origin's root, or a PR preview's `/pr-<n>/`.
 */
export default defineConfig({
  ...base,
  base: './',
  plugins: [react()],
  // The debug-only dev client registers the root of the port
  // `dev-app-ports.json` pins under `fhir-sync-pebble-dev` as its redirect, so
  // the dev server must hold exactly it. Run with
  // `vp run -F @wildflowerhealthio/fhir-sync-pebble-web dev`.
  server: devAppServer('fhir-sync-pebble-dev'),
  build: {
    // Published beside the bundle and referenced from it, so devtools show the
    // original source in production; the deploy also uploads them to Sentry
    // (scripts/ci/upload-sentry-sourcemaps.sh).
    sourcemap: true,
    rolldownOptions: {
      input: {
        main: './index.html',
      },
    },
  },
  test: {
    ...base.test,
    environment: 'jsdom',
  },
})
