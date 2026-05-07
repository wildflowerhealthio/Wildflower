import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import type { Plugin } from 'vite-plus'
import { defineConfig } from 'vite-plus'

// Re-emit `viteSingleFile`'s inlined HTML as both a JS string export and a
// `.d.ts` declaration. Lets downstream packages (`gatekeeper-expo`) import
// `embeddable-html` and pass the bundled SPA into a `react-native-webview`
// without shipping a separate static asset.
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
