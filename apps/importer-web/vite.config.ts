import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

import base from '../../vite.config.base.ts'

// SINGLE SOURCE OF TRUTH: `slices/apps/dev-app-ports.json` pins the port this
// dev server binds to. `apps-rust` embeds the same file (`src/dev_seed.rs`) to
// seed the debug-only `importer-app-dev` self-hosted row, whose loopback origin
// the homescreen tile launches — so the row and this server cannot drift. Read
// at config-eval time (Node), like the Tauri app reads
// `tauri-shared-config.json`.
const devPortsPath = fileURLToPath(new URL('../../slices/apps/dev-app-ports.json', import.meta.url))

const isDevPorts = (value: unknown): value is { 'importer-app-dev': number } =>
  typeof value === 'object' &&
  value !== null &&
  'importer-app-dev' in value &&
  typeof value['importer-app-dev'] === 'number'

const parsedDevPorts: unknown = JSON.parse(readFileSync(devPortsPath, 'utf8'))
if (!isDevPorts(parsedDevPorts)) {
  throw new Error(
    `dev-app-ports.json must declare a number "importer-app-dev" (at ${devPortsPath})`
  )
}
const devPort = parsedDevPorts['importer-app-dev']

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
  server: {
    // Pinned to the shared dev-port file (above), and `strictPort` so vite fails
    // loudly rather than drifting onto the next free port: the homescreen's
    // "Importer (Dev)" tile launches that port's `/launch.html`, which a moved
    // dev server would leave serving the stale vendored build instead. Run with
    // `vp run -F wildflower-importer dev`.
    port: devPort,
    strictPort: true,
    host: '0.0.0.0',
  },
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
