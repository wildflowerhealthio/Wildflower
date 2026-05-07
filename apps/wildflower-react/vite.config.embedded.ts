import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import type { Plugin } from 'vite-plus'
import { defineConfig } from 'vite-plus'

// Inlined from the previous `kitchen-sink/bundling` helper. After this
// package owns the only `viteSingleFile` consumer, the helper has no
// remaining callers; it lives here to keep the dependency edge narrow.
const emitHtmlAsModule = (): Plugin => ({
  name: 'wildflower-react:emit-html-as-module',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const entry = Object.values(bundle).find(
      (item) => item.type === 'asset' && item.fileName.endsWith('.html')
    )
    if (entry === undefined || entry.type !== 'asset') return
    let source: string
    if (typeof entry.source === 'string') {
      source = entry.source
    } else {
      source = entry.source.toString()
    }
    this.emitFile({
      type: 'asset',
      fileName: 'html.js',
      source: `export const html = ${JSON.stringify(source)};\n`,
    })
    this.emitFile({
      type: 'asset',
      fileName: 'html.d.ts',
      source: 'export declare const html: string;\n',
    })
  },
})

export default defineConfig({
  plugins: [react(), viteSingleFile(), emitHtmlAsModule()],
  resolve: { conditions: ['source'] },
  build: {
    outDir: 'dist-embedded',
    rollupOptions: {
      input: 'index-embedded.html',
    },
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
})
