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
    // Published beside the bundle and referenced from it, so devtools show the
    // original source in production; the deploy also uploads them to Sentry
    // (scripts/ci/upload-sentry-sourcemaps.sh).
    sourcemap: true,
    rolldownOptions: { input: 'index.html' },
  },
  // The hosted dev server binds `launcher-dev`'s port from
  // `dev-app-ports.json`: the debug Tauri host links its launcher
  // pages (logout's landing, the 404 link)
  // to the same port (`src-tauri/build.rs` reads that file too), so those
  // links land here and the OAuth redirect URI stays stable. The launcher has
  // no homescreen dev tile; `apps-rust/src/dev_seed.rs` reads only the keys
  // it seeds a row for.
  server: devAppServer('launcher-dev'),
})
