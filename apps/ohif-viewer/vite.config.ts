import { defineConfig } from 'vite-plus'

import base, { devAppServer } from '../../vite.config.base.ts'

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
  // The homescreen's "Imaging (Dev)" tile launches this port and there is no
  // vendored fallback build for the host to serve in its place, so the preview
  // server must hold exactly it. Run with `vp run -F ohif-viewer dev`.
  preview: devAppServer('ohif-viewer-dev'),
  test: {
    ...base.test,
    include: ['src/**/*.test.ts'],
  },
})
