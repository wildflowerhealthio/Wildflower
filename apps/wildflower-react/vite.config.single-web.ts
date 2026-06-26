import { viteSingleFile } from 'vite-plugin-singlefile'
import type { Plugin } from 'vite-plus'
import { defineConfig } from 'vite-plus'
import baseConfig from './vite.config.base.ts'

// Re-emit `viteSingleFile`'s inlined HTML as both a JS string export and a
// `.d.ts` declaration. Lets downstream packages import the bundled SPA as a
// JS string without shipping a separate static asset.
const emitHtmlAsModule = (): Plugin => ({
  name: 'single-file:emit-html-as-module',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const entry = Object.values(bundle).find(
      (item) => item.type === 'asset' && item.fileName.endsWith('.html')
    )
    if (entry === undefined || entry.type !== 'asset') return
    const source = typeof entry.source === 'string' ? entry.source : entry.source.toString()
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
  ...baseConfig,
  plugins: [...(baseConfig.plugins ?? []), viteSingleFile(), emitHtmlAsModule()],
  build: {
    outDir: 'dist-single-web',
    rollupOptions: { input: 'index-single-web.html' },
  },
})
