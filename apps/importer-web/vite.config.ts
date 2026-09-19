import { createRequire } from 'node:module'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

import base, { devAppServer } from '../../vite.config.base.ts'

/**
 * Node's `events`, which Vite externalizes to a stub that warns and yields
 * `undefined` for every property. One module in this app's graph needs the real
 * thing at evaluation time:
 *
 * `@cornerstonejs/core` (the DICOM preview's renderer) → `cache/classes/Mesh.js`
 * → vtk.js `IO/XML/XMLPolyDataReader` → `XMLReader` → `xmlbuilder2`, which is
 * CJS and does `class XMLBuilderCBImpl extends events_1.EventEmitter` at module
 * scope. Against the stub that throws "class heritage ... is not an object or
 * null" while core is still evaluating, so the whole package fails to import and
 * the preview reports every file as unrenderable.
 *
 * Resolved to a file path rather than left bare, so the alias does not simply
 * re-match the builtin it is replacing.
 */
const eventsShim = createRequire(import.meta.url).resolve('events/')

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
  resolve: { ...base.resolve, alias: { events: eventsShim } },
  /**
   * Pre-bundling breaks the DICOM preview's decode worker and WASM codec URLs;
   * `include` lists the CommonJS dependencies reached through the excluded
   * package. Both halves, and the misleading symptom they produce, are in the
   * {@link ../../slices/file-formats/docs/Cornerstone Rendering Explanation.md | Cornerstone Rendering Explanation}.
   */
  optimizeDeps: {
    exclude: ['@cornerstonejs/dicom-image-loader'],
    include: [
      'dicom-parser',
      '@cornerstonejs/codec-charls/decodewasmjs',
      '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs',
      '@cornerstonejs/codec-openjpeg/decodewasmjs',
      '@cornerstonejs/codec-openjph/wasmjs',
    ],
  },
  worker: { format: 'es' },
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
