import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

import base, { devAppServer } from '../../vite.config.base.ts'

/**
 * A SMART-on-FHIR app built as a static bundle into this package's default
 * `dist/`, which `apps/github-pages` publishes. One HTML entry, `index.html`:
 * the app root, which starts a SMART launch its URL carries (an EHR's `iss` and
 * `launch`, or a lone `iss`), completes the handshake and renders the app when
 * a callback is in the URL, and shows the standalone connect menu otherwise.
 * A relative `base` so the built assets
 * resolve from whatever origin / path the bundle is served at.
 */
export default defineConfig({
  ...base,
  base: './',
  plugins: [react()],
  // The homescreen's "Synthetic Data (Dev)" tile launches this port's
  // root, so the dev server must hold exactly it. Run with
  // `vp run -F synthetic-data-app dev`.
  server: devAppServer('synthetic-data-app-dev'),
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
