import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite-plus'

import base, { devAppServer } from '../../../vite.config.base.ts'
// A relative import of the source, not `app-catalog-core-js/location`: this
// runs while Vite loads its config, under plain Node, where a workspace package
// resolves to its built `dist/`, which a fresh checkout doesn't have yet.
import { CATALOG_JSON_PATH, CATALOG_PATH } from '../app-catalog-core-js/src/location.ts'

/** The committed catalog, `public/apps.json`, which Vite serves and copies as is. */
const CATALOG_FILE = join(import.meta.dirname, 'public', CATALOG_JSON_PATH)

/**
 * Publishes the catalog at {@link CATALOG_PATH}, the extensionless path HALO
 * names, with the same bytes as `public/apps.json`: the build emits it beside
 * the copy Vite makes of `public/`, and the dev server answers it (as
 * `application/json`) where it would otherwise fall back to `index.html`.
 * `public/` cannot hold the second name without a second committed copy.
 */
const catalogAtHaloPath = (): Plugin => ({
  name: 'app-catalog-web:catalog-at-halo-path',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const { pathname } = new URL(request.url ?? '/', 'http://dev.invalid')
      if (pathname !== `${server.config.base}${CATALOG_PATH}`) {
        next()
        return
      }
      response.setHeader('content-type', 'application/json')
      response.end(readFileSync(CATALOG_FILE))
    })
  },
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: CATALOG_PATH, source: readFileSync(CATALOG_FILE) })
  },
})

/**
 * The App Catalog at `https://app-catalog.wildflowerhealth.io/`, built into
 * this package's default `dist/`, which `.github/workflows/deploy-pages-site.yml`
 * publishes. `public/apps.json` is the catalog; Vite copies it into the build,
 * and {@link catalogAtHaloPath} publishes it at `apps` too. A relative `base`
 * so the built assets resolve from whatever path the bundle is served at: its
 * origin's root, or a PR preview's `/pr-<n>/`.
 */
export default defineConfig({
  ...base,
  base: './',
  plugins: [react(), catalogAtHaloPath()],
  // Run with `vp run -F @wildflowerhealthio/app-catalog-web dev`.
  server: devAppServer('app-catalog-dev'),
  test: {
    ...base.test,
  },
})
