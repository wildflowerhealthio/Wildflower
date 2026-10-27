import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

import base, { devAppServer } from '../../../vite.config.base.ts'

/**
 * The App Catalog at `https://app-catalog.wildflowerhealth.io/`, built into
 * this package's default `dist/`, which `.github/workflows/deploy-pages-site.yml`
 * publishes. `public/apps.json` is the catalog; Vite copies it into the build,
 * and `scripts/write-catalog.ts` then copies it to `dist/apps`, the path HALO
 * names. A relative `base` so the built assets resolve from whatever path the
 * bundle is served at: its origin's root, or a PR preview's `/pr-<n>/`.
 */
export default defineConfig({
  ...base,
  base: './',
  plugins: [react()],
  // Run with `vp run -F @wildflowerhealthio/app-catalog-web dev`.
  server: devAppServer('app-catalog-dev'),
  test: {
    ...base.test,
  },
})
