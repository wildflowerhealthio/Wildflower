import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

import base, { devAppServer } from '../../../vite.config.base.ts'

/**
 * Wildflower Authorization, built as a static bundle into this package's
 * default `dist/`, which `.github/workflows/deploy-pages-site.yml` publishes
 * at `https://authorization.wildflowerhealth.io/`. One HTML entry, `index.html`: the connect menu, the
 * OAuth redirect target, and the signed-in access pages. A relative `base` so
 * the built assets resolve from whatever origin / path the bundle is served
 * at (its origin's root, or a PR preview's `/pr-<n>/`).
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
  // Run with `vp run -F @wildflowerhealthio/authorization-web dev`. Its
  // address is no registered redirect, so a sign-in from it goes through the
  // consent prompt's "this app is asking to return somewhere new" warning.
  server: devAppServer('authorization-dev'),
  build: {
    // Published beside the bundle and referenced from it, so devtools show the
    // original source in production; the deploy also uploads them to Sentry
    // (scripts/ci/upload-sentry-sourcemaps.sh).
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
