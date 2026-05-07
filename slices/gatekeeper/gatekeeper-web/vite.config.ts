import react from '@vitejs/plugin-react'
import { emitHtmlAsModule } from 'kitchen-sink/bundling'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  plugins: [react(), viteSingleFile(), emitHtmlAsModule()],
  resolve: {
    conditions: ['source'],
  },
  base: '/auth/ui/',
  build: {
    outDir: 'dist-html',
  },
  pack: {
    dts: { tsgo: true },
    platform: 'neutral',
    exports: false,
    clean: false,
    entry: {
      index: 'src/index.ts',
    },
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
})
