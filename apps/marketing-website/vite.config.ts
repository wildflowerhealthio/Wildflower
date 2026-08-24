import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

import base from '../../vite.config.base.ts'

/**
 * The marketing site is a standalone single-page React app (no workspace
 * slices, no router plugin), so it only needs the base config plus the
 * React transform. Component logic is exercised under jsdom — the same
 * Vitest environment the rest of the React packages use — and registered
 * in the root `vite.config.ts` `test.projects` list so `vp test` from the
 * repo root picks it up.
 */
export default defineConfig({
  ...base,
  // Relative base so the built assets resolve from any path. The site is
  // served at the root of its custom domain (wildflowerhealth.io), but
  // until that domain's DNS is live GitHub Pages serves it from the project
  // sub-path (…/wildflower/); a relative base works for both with no repo
  // name baked into the build.
  base: './',
  plugins: [react()],
  test: {
    ...base.test,
    environment: 'jsdom',
  },
})
