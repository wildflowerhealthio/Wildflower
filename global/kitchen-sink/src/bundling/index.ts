/**
 * Vite plugin: emit the bundled `index.html` as a JS module so other
 * packages can import the document as a string. Pairs with
 * `vite-plugin-singlefile` (or any plugin that inlines all assets into
 * one HTML file) to produce a self-contained bundle that an embedding
 * host — a React Native WebView, a server-rendered shell, etc. — can
 * load via `import { html } from '<package>/html'`.
 *
 * This lives in `kitchen-sink/bundling` rather than alongside any
 * particular consumer because the pattern is project-agnostic.
 */

import type { Plugin } from 'vite-plus'

interface EmitHtmlAsModuleOptions {
  /**
   * The asset filename to emit the JS module under (without the
   * leading slash). Defaults to `'html.js'`.
   */
  readonly fileName?: string
  /**
   * The exported binding name used in the generated module. Defaults
   * to `'html'`, producing `export const html = "...";`.
   */
  readonly exportName?: string
}

const emitHtmlAsModule = (options: EmitHtmlAsModuleOptions = {}): Plugin => {
  const fileName = options.fileName ?? 'html.js'
  const exportName = options.exportName ?? 'html'
  const dtsFileName = fileName.replace(/\.js$/, '.d.ts')
  return {
    name: 'kitchen-sink:emit-html-as-module',
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
        fileName,
        source: `export const ${exportName} = ${JSON.stringify(source)};\n`,
      })
      this.emitFile({
        type: 'asset',
        fileName: dtsFileName,
        source: `export declare const ${exportName}: string;\n`,
      })
    },
  }
}

export { emitHtmlAsModule }
export type { EmitHtmlAsModuleOptions }
