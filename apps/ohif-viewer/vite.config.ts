import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'

import base from '../../vite.config.base.ts'

// SINGLE SOURCE OF TRUTH: `slices/apps/dev-app-ports.json` pins the port.
// `apps-rust/src/dev_seed.rs` embeds the same file — so they cannot drift.
const devPortsPath = fileURLToPath(new URL('../../slices/apps/dev-app-ports.json', import.meta.url))

const isDevPorts = (value: unknown): value is { 'ohif-viewer-dev': number } =>
  typeof value === 'object' &&
  value !== null &&
  'ohif-viewer-dev' in value &&
  typeof value['ohif-viewer-dev'] === 'number'

const parsedDevPorts: unknown = JSON.parse(readFileSync(devPortsPath, 'utf8'))
if (!isDevPorts(parsedDevPorts)) {
  throw new Error(`dev-app-ports.json must declare a number "ohif-viewer-dev" (at ${devPortsPath})`)
}
const devPort = parsedDevPorts['ohif-viewer-dev']

/**
 * This package bundles nothing itself: its build downloads the prebuilt OHIF
 * viewer pinned in `prebuilt.json` and lays `config/app-config.js` over it
 * (see `src/build.ts`). The config exists so the pin parsing, the archive
 * verification and the runtime config's basename logic run as their own
 * Vitest project, registered in the root `vite.config.ts` `test.projects`
 * list. Node environment: the code under test is filesystem, hashing and
 * string logic, not UI. `vp preview` serves `dist/` for a local look at
 * whatever the last build produced (the stub or the real viewer), on the port
 * the debug-only `ohif-viewer-dev` app row targets.
 */
export default defineConfig({
  ...base,
  run: {
    tasks: {
      build: {
        command: 'node ./src/build.ts',
        untrackedEnv: [
          'HTTPS_PROXY',
          'HTTP_PROXY',
          'NO_PROXY',
          'NODE_EXTRA_CA_CERTS',
          'NODE_USE_ENV_PROXY',
          'SSL_CERT_FILE',
        ],
      },
    },
  },
  preview: {
    // Pinned to the shared dev-port file (above), and `strictPort` so vite fails
    // loudly rather than drifting onto the next free port: the homescreen's
    // "Imaging (Dev)" tile launches this port, and there is no vendored fallback
    // build for the host to serve in its place. Run with
    // `vp run -F ohif-viewer dev`.
    port: devPort,
    strictPort: true,
    host: '0.0.0.0',
  },
  test: {
    ...base.test,
    include: ['src/**/*.test.ts'],
  },
})
