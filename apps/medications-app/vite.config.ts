import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

import base from '../../vite.config.base.ts'

/**
 * A SMART-on-FHIR app served as a self-hosted bundle. Two HTML entries:
 * `launch.html` (the EHR launch endpoint — kicks off the OAuth2 authorize
 * redirect) and `index.html` (the OAuth redirect target that completes the
 * handshake and renders the app). A relative `base` so the built assets resolve
 * from whatever subdomain / path the self-hosted app is served at.
 */
export default defineConfig({
  ...base,
  base: './',
  plugins: [react()],
  build: {
    // Build straight into the vendored self-hosted-apps tree so the bundle
    // ships as a Tauri resource (`wildflower-tauri/src-tauri/tauri.conf.json`
    // maps the whole `slices/apps/self-hosted-apps/` dir into `bundle.resources`)
    // and the host's `sync_vendored_self_hosted_apps` seeds it into app-data on
    // startup. The folder is gitignored like every other vendored build.
    //
    // The trailing segment is deliberately `medication`, not the package name
    // `medications-app`: it is the `content_folder` of the seeded app row
    // (`apps-rust` migration `0003_seed_wildflower_medication_app`) and the
    // path baked into the Tauri `bundle.resources`, so it can only change
    // alongside a migration.
    outDir: '../../slices/apps/self-hosted-apps/medication',
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        main: './index.html',
        launch: './launch.html',
      },
    },
  },
  test: {
    ...base.test,
    environment: 'jsdom',
  },
})
