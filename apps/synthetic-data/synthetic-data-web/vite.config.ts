import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

import base, { devAppServer } from '../../../vite.config.base.ts'

/**
 * A SMART-on-FHIR app built as a static bundle into this package's default
 * `dist/`, which `.github/workflows/deploy-pages-site.yml` publishes. One HTML entry, `index.html`:
 * the app root, which starts a SMART launch its URL carries (an EHR's `iss` and
 * `launch`, or a lone `iss`), completes the handshake and renders the app when
 * a callback is in the URL, and shows the standalone connect menu otherwise.
 * A relative `base` so the built assets
 * resolve from whatever path the bundle is served at: its origin's root, or a
 * PR preview's `/pr-<n>/`.
 */
export default defineConfig({
  ...base,
  base: './',
  plugins: [react()],
  // The homescreen's "Synthetic Data (Dev)" tile launches this port's
  // root, so the dev server must hold exactly it. Run with
  // `vp run -F @wildflowerhealthio/synthetic-data-web dev`.
  server: devAppServer('synthetic-data-dev'),
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
