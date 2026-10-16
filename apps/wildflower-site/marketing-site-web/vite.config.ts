import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

import base from '../../../vite.config.base.ts'

/**
 * The marketing site is a standalone React site with no router plugin (its
 * chrome comes from the `branding` slice), so it only needs the base config
 * plus the React transform. It builds five HTML entries: the homepage and the
 * four policy pages, each its own directory so it is served at
 * `/privacy-policy/`, `/consumer-health-data/`, `/terms/` and `/deletion/`. Component logic is exercised under jsdom — the
 * same Vitest environment the rest of the React packages use — and registered
 * in the root `vite.config.ts` `test.projects` list so `vp test` from the
 * repo root picks it up.
 */
export default defineConfig({
  ...base,
  // Relative base so the built assets resolve from any path: the root of the
  // custom domain (wildflowerhealth.io), and a PR preview's
  // `…/staging/pr-<n>/`, with no path baked into the build.
  base: './',
  plugins: [react()],
  build: {
    rolldownOptions: {
      input: [
        'index.html',
        'privacy-policy/index.html',
        'consumer-health-data/index.html',
        'terms/index.html',
        'deletion/index.html',
      ],
    },
  },
  test: {
    ...base.test,
    environment: 'jsdom',
  },
})
