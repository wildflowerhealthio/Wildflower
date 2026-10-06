import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

import base from '../../../vite.config.base.ts'

/**
 * The relay's admin UI, built as a static bundle into this package's
 * `dist/`, which the relay (`apps/relay/server`) embeds in its binary and
 * serves at `/` on `admin.<domain>`, beside the admin API it calls. One HTML
 * entry, `index.html`, at the root of the site, and Vite's hashed file names
 * under `assets/`, which the relay serves as immutable.
 *
 * Nothing is inlined into the HTML or as a `data:` URL: the relay serves
 * every file under `Content-Security-Policy: default-src 'self'`, which
 * allows only files fetched from the site itself.
 */
export default defineConfig({
  ...base,
  base: '/',
  plugins: [react()],
  build: {
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: {
        main: './index.html',
      },
    },
  },
})
