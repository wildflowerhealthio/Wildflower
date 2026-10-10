import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

import base, { devAppServer } from '../../../vite.config.base.ts'

/**
 * A SMART-on-FHIR app built as a static bundle into this package's default
 * `dist/`, which `apps/wildflower-site/wildflower-site-web` publishes. One HTML entry, `index.html`:
 * the standalone connect menu on a bare visit, and the OAuth redirect target
 * that completes the handshake and renders the Pebble settings page when a
 * callback is in the URL. No EHR launches it — the app is only ever opened
 * standalone, from the Pebble phone app's watchapp settings. A relative
 * `base` so the built assets resolve from whatever origin / path the bundle is
 * served at — on the GitHub Pages site that is the `/fhir-sync-pebble` subpath.
 */
export default defineConfig({
  ...base,
  base: './',
  plugins: [react()],
  // The debug-only `fhir-sync-pebble-dev` client registers this port's root as
  // its redirect, so the dev server must hold exactly it. Run with
  // `vp run -F fhir-sync-pebble-web dev`.
  server: devAppServer('fhir-sync-pebble-dev'),
  build: {
    // Emitted for the deploy's Sentry upload, unreferenced from the bundle;
    // the deploy deletes them before publishing (.github/actions/sentry-sourcemaps).
    sourcemap: 'hidden',
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
