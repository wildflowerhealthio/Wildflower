import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

import base, { devAppServer } from '../../../vite.config.base.ts'

/**
 * A SMART-on-FHIR app built as a static bundle into this package's default
 * `dist/`, which `.github/workflows/deploy-pages-site.yml` publishes. One HTML entry, `index.html`:
 * the app root, which starts a SMART launch its URL carries (an EHR's `iss` and
 * `launch`, or a lone `iss`), completes the handshake and renders the app when
 * a callback is in the URL, and shows the standalone connect menu otherwise.
 * A relative `base` so the built assets
 * resolve from whatever path the bundle is served at: its origin's root, or a
 * PR preview's `/pr-<n>/`.
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
  // The homescreen's "Wildflower Strength (Dev)" tile launches this port's
  // root, so the dev server must hold exactly it. Run with
  // `vp run -F @wildflowerhealthio/strength-web dev`.
  server: devAppServer('strength-dev'),
  build: {
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
