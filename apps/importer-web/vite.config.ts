import { createRequire } from 'node:module'

import { tanstackRouter } from '@tanstack/router-plugin/vite'
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
 * A SMART-on-FHIR app built as a static bundle into this package's default
 * `dist/`, which `.github/workflows/deploy-pages-site.yml` publishes. One HTML entry, `index.html`:
 * the app root, which starts a SMART launch its URL carries (an EHR's `iss` and
 * `launch`, or a lone `iss`), completes the handshake and renders the app when
 * a callback is in the URL, and shows the standalone connect menu otherwise.
 * A relative `base` so the built assets
 * resolve from whatever path the app is served at: its origin's root, or a PR
 * preview's `/pr-<n>/`.
 *
 * `tanstackRouter` must run before `react()` so the generated route tree is
 * in place before the React transform. It reads the route files under
 * `src/routes` and writes `src/routeTree.gen.ts`.
 */
export default defineConfig({
  ...base,
  base: './',
  plugins: [
    tanstackRouter({
      target: 'react',
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      autoCodeSplitting: false,
      // Colocated `*.test.tsx` files live beside the route modules they
      // exercise; without this the route generator would treat them as routes.
      routeFileIgnorePattern: '\\.(test|spec)\\.',
    }),
    react(),
  ],
  resolve: { ...base.resolve, alias: { events: eventsShim } },
  /**
   * Pre-bundling breaks the DICOM preview's decode worker and WASM codec URLs;
   * `include` lists the CommonJS dependencies reached through the excluded
   * package. Both halves, and the misleading symptom they produce, are in the
   * [Cornerstone Rendering Explanation](../../slices/file-formats/docs/Cornerstone%20Rendering%20Explanation.md).
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
  // root, so the dev server must hold exactly it. Run with
  // `vp run -F @wildflowerhealthio/importer-web dev`.
  server: devAppServer('importer-dev'),
  build: {
    // Published beside the bundle and referenced from it, so devtools show the
    // original source in production; the deploy also uploads them to Sentry
    // (.github/actions/sentry-sourcemaps).
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
