import { defineConfig } from 'vite-plus'
import baseConfig from './vite.config.base.ts'

export default defineConfig({
  ...baseConfig,
  base: './',
  build: {
    outDir: 'dist-web',
    rolldownOptions: { input: 'index.html' },
  },
})
