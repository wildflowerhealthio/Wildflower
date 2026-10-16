import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

import base, { devAppServer } from '../../../vite.config.base.ts'

/**
 * The WatchLifts watchapp's settings page, built as a static bundle into this
 * package's default `dist/`, which `.github/workflows/deploy-pages-site.yml` publishes. One HTML
 * entry, `index.html`, and no SMART launch: the Pebble phone app opens it with
 * the weights and `return_to` in the query. A relative `base` so the built
 * assets resolve from whatever path the bundle is served at: its origin's
 * root, or a PR preview's `/pr-<n>/`.
 */
export default defineConfig({
  ...base,
  base: './',
  plugins: [react()],
  // Run with `vp run -F @wildflowerhealthio/watch-lifts-web dev`.
  server: devAppServer('watch-lifts-dev'),
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
