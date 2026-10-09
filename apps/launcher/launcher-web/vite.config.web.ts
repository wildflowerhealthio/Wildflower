import { defineConfig } from 'vite-plus'
import { devAppServer } from '../../../vite.config.base.ts'
import { devDeepLinkRedirect } from './src/dev-server/deep-link-redirect.ts'
import baseConfig from './vite.config.base.ts'

export default defineConfig({
  ...baseConfig,
  base: './',
  // Deep links on the dev server take the same `?redirect=` detour GitHub Pages
  // gives them, so boot sees the app root either way. See the plugin.
  plugins: [...(baseConfig.plugins ?? []), devDeepLinkRedirect()],
  build: {
    outDir: 'dist-web',
    // Emitted for the deploy's Sentry upload, unreferenced from the bundle;
    // the deploy deletes them before publishing (.github/actions/sentry-sourcemaps).
    sourcemap: 'hidden',
    rolldownOptions: { input: 'index.html' },
  },
  // The hosted dev server binds `launcher-dev`'s port from
  // `slices/apps/dev-app-ports.json`: the debug Tauri host links its launcher
  // pages (the device-flow `verification_uri`, logout's landing, the 404 link)
  // to the same port (`src-tauri/build.rs` reads that file too), so those
  // links land here and the OAuth redirect URI stays stable. The launcher has
  // no homescreen dev tile; `apps-rust/src/dev_seed.rs` reads only the keys
  // it seeds a row for.
  server: devAppServer('launcher-dev'),
})
