import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

import base, { devAppServer } from '../../../vite.config.base.ts'

/**
 * Wildflower Authorization, built as a static bundle into this package's
 * default `dist/`, which `apps/wildflower-site/wildflower-site-web` publishes
 * at `/authorization/`. One HTML entry, `index.html`: the connect menu, the
 * OAuth redirect target, and the signed-in access pages. A relative `base` so
 * the built assets resolve from whatever origin / path the bundle is served
 * at (`/authorization/`, or a PR preview's `/staging/pr-<n>/authorization/`).
 */
export default defineConfig({
  ...base,
  base: './',
  plugins: [react()],
  // Run with `vp run -F @wildflowerhealthio/authorization-web dev`. Its
  // address is no registered redirect, so a sign-in from it goes through the
  // consent prompt's "this app is asking to return somewhere new" warning.
  server: devAppServer('authorization-dev'),
  build: {
    // Emitted for the deploy's Sentry upload, unreferenced from the bundle;
    // the deploy deletes them before publishing (.github/actions/sentry-sourcemaps).
    sourcemap: 'hidden',
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
