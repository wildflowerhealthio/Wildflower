import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import type { Plugin } from 'vite-plus'
import { defineConfig } from 'vite-plus'

const emitHtmlAsModule = (): Plugin => ({
  name: 'gatekeeper-web:emit-html-as-module',
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
      'http-api': 'src/http-api.ts',
      'http-api-implementation': 'src/http-api-implementation.ts',
      'auth-renderer': 'src/auth-renderer.tsx',
    },
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
})
