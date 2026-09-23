import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

import base, { devAppServer } from '../../vite.config.base.ts'

/**
 * A SMART-on-FHIR app built as a static bundle into this package's default
 * `dist/`, which `apps/github-pages` publishes. Two HTML entries:
 * `launch.html` (the EHR launch endpoint — kicks off the OAuth2 authorize
 * redirect) and `index.html` (the app root — the OAuth redirect target that
 * completes the handshake and renders the app when a callback is in the URL, and
 * the standalone connect menu otherwise). A relative `base` so the built assets
 * resolve from whatever origin / path the bundle is served at.
 */
export default defineConfig({
  ...base,
  base: './',
  plugins: [react()],
  // The homescreen's "Medications (Dev)" tile launches this port's
  // `/launch.html`, so the dev server must hold exactly it. Run with
  // `vp run -F medications-app dev`.
  server: devAppServer('medications-app-dev'),
  build: {
    rolldownOptions: {
      input: {
        main: './index.html',
        launch: './launch.html',
      },
    },
  },
  test: {
    ...base.test,
    environment: 'jsdom',
  },
})
