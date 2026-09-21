import { viteSingleFile } from 'vite-plugin-singlefile'
import { defineConfig } from 'vite-plus'
import baseConfig from './vite.config.base.ts'

// Builds `dist-single-web/index-single-web.html`: the whole SPA inlined into
// one HTML file, which `apps/wildflower-tauri/src-tauri/src/spa.rs`
// `include_str!`s at compile time. That `include_str!` is the only consumer —
// nothing imports the bundle as a JS module.
export default defineConfig({
  ...baseConfig,
  plugins: [...(baseConfig.plugins ?? []), viteSingleFile()],
  build: {
    outDir: 'dist-single-web',
    rolldownOptions: { input: 'index-single-web.html' },
  },
})
