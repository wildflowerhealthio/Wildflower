import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

import base from '../../../../vite.config.base.ts'
import { pageScriptBudget, SHARED_REACT_CHUNK } from './page-script-budget.ts'

/**
 * The authorization pages, built as a static bundle into this package's
 * `dist/`, which the authorization server
 * (`apps/host/wildflower-server/authorization-server-rust`) embeds in its
 * binary and serves on the server's own origin. One HTML input per page, each
 * served at its own path: `consent.html` at `/oauth/authorize/{id}/consent`,
 * `device.html` at `/oauth/device`, `pair.html` at `/oauth/pair`.
 *
 * - `base: '/oauth/'`, so a page loads its files from `/oauth/assets/`, where
 *   the server serves Vite's content-hashed scripts, stylesheets and fonts
 *   as immutable, whatever path the page itself is at.
 * - Each page loads its own entry and the shared `react` chunk, so a page
 *   never ships another page's code and React is cached once.
 * - Nothing is inlined into the HTML or as a `data:` URL: the server serves
 *   every file under the wait page's Content Security Policy, which allows
 *   only scripts, stylesheets and fonts fetched from the server itself.
 * - `pageScriptBudget` fails the build when a page's JavaScript beside the
 *   shared React chunk is over 150 KB gzipped.
 */
export default defineConfig({
  ...base,
  base: '/oauth/',
  plugins: [react(), pageScriptBudget()],
  build: {
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: {
        consent: './consent.html',
        device: './device.html',
        pair: './pair.html',
      },
      output: {
        codeSplitting: {
          groups: [
            {
              name: SHARED_REACT_CHUNK,
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
          ],
        },
      },
    },
  },
  test: {
    ...base.test,
    environment: 'jsdom',
  },
})
