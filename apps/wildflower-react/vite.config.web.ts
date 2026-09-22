import { defineConfig } from 'vite-plus'
import baseConfig from './vite.config.base.ts'

export default defineConfig({
  ...baseConfig,
  base: './',
  build: {
    outDir: 'dist-hosted',
    rolldownOptions: { input: 'index-hosted.html' },
  },
})
