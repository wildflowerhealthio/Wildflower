import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

import base, { devAppServer } from '../../vite.config.base.ts'

/**
 * A SMART-on-FHIR app served as a self-hosted bundle. Two HTML entries:
 * `launch.html` (the EHR launch endpoint — kicks off the OAuth2 authorize
 * redirect) and `index.html` (the app root — the OAuth redirect target that
 * completes the handshake and renders the app when a callback is in the URL, and
 * the standalone connect menu otherwise). A relative `base` so the built assets
 * resolve from whatever subdomain / path the app is served at — on device that
 * is a loopback origin's root, and on the GitHub Pages site it is the
 * `/importer-app` subpath `apps/github-pages` stages this build into.
 */
export default defineConfig({
  ...base,
  base: './',
  plugins: [react()],
  // The homescreen's "Importer (Dev)" tile launches this port's
  // `/launch.html`, so the dev server must hold exactly it. Run with
  // `vp run -F wildflower-importer dev`.
  server: devAppServer('importer-app-dev'),
  build: {
    // Build straight into the vendored self-hosted-apps tree so the bundle
    // ships as a Tauri resource (`wildflower-tauri/src-tauri/tauri.conf.json`
    // maps the whole `slices/apps/self-hosted-apps/` dir into `bundle.resources`)
    // and the host's `sync_vendored_self_hosted_apps` seeds it into app-data on
    // startup. The folder is gitignored like every other vendored build, and its
    // name is the `content_folder` the seed migration / dev row records.
    outDir: '../../slices/apps/self-hosted-apps/importer',
    emptyOutDir: true,
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
