import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['source'] },
  base: '/',
  build: {
    outDir: 'dist-web',
    rollupOptions: {
      input: 'index.html',
    },
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
})
