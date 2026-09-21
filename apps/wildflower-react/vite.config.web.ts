import { defineConfig } from 'vite-plus'
import baseConfig from './vite.config.base.ts'

// Dev-server config only (`vp run dev`, serving `index.html` →
// `src/main-web.tsx`). There is no `build:web` script: the `dist-web/` bundle
// it used to emit had no consumer once the static host that served it left the
// repo. #694 repurposes this config as the hosted (GitHub Pages) build.
export default defineConfig({
  ...baseConfig,
  base: '/',
})
