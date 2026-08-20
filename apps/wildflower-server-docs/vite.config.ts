import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'

import base from '../../vite.config.base.ts'

// SINGLE SOURCE OF TRUTH: `slices/apps/dev-app-ports.json` pins the port this
// dev server binds to. `apps-rust` embeds the same file (`src/dev_seed.rs`) to
// seed the debug-only `web-trace-app-dev` self-hosted row, whose loopback origin
// the homescreen tile launches — so the row and this server cannot drift. Read
// at config-eval time (Node), like the Tauri app reads
// `tauri-shared-config.json`.
const devPortsPath = fileURLToPath(new URL('../../slices/apps/dev-app-ports.json', import.meta.url))

const isDevPorts = (value: unknown): value is { 'web-server-docs-dev': number } =>
  typeof value === 'object' &&
  value !== null &&
  'web-server-docs-dev' in value &&
  typeof value['web-server-docs-dev'] === 'number'

const parsedDevPorts: unknown = JSON.parse(readFileSync(devPortsPath, 'utf8'))
if (!isDevPorts(parsedDevPorts)) {
  throw new Error(
    `dev-app-ports.json must declare a number "web-server-docs-dev" (at ${devPortsPath})`
  )
}
const devPort = parsedDevPorts['web-server-docs-dev']

/**
 * The static "Wildflower server docs" console published at
 * `/wildflower-server-docs`: a Scalar API reference over the six committed
 * slice OpenAPI snapshots, pointed at whichever running server the reader
 * names via `?server=`.
 *
 * Everything is bundled — the Scalar reference comes from its npm package and
 * the specs are imported from `slices/**`, so the published page loads no CDN
 * script and no remote document. A relative `base` so the assets resolve from
 * the site sub-path (`apps/github-pages` copies `dist/` there verbatim).
 *
 * Tests here are pure unit tests over the `?server=` parsing and the spec
 * transforms, so the default node environment is enough.
 */
export default defineConfig({
  ...base,
  base: './',
  server: {
    // Pinned to the shared dev-port file (above), and `strictPort` so vite fails
    // loudly rather than drifting onto the next free port: the homescreen's
    // "Wildflower Server Docs" tile launches that port's `/launch.html`, which a moved dev
    // server would leave serving the stale vendored build instead. Run with
    // `vp run -F wildflower-server-docs dev`.
    port: devPort,
    strictPort: true,
    host: '0.0.0.0',
  },
  build: {
    // Vendoring the whole Scalar reference (plus the bundled OpenAPI
    // snapshots, the FHIR one alone ~300 kB) is the point of this package —
    // the alternative is the CDN script, which a self-contained published page
    // must not load. So a multi-megabyte chunk is expected, not a packaging
    // mistake, and the warning would only be noise.
    chunkSizeWarningLimit: 4000,
  },
  test: {
    ...base.test,
  },
})
