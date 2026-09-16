import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: [
    {
      deps: { resolveDepSubpath: true },
      dts: { generator: 'tsgo', tsgo: {} },
      exports: false,
      platform: 'neutral',
      entry: { index: 'src/index.ts' },
    },
    {
      deps: { resolveDepSubpath: true },
      dts: { generator: 'tsgo', tsgo: {} },
      exports: false,
      platform: 'neutral',
      entry: { 'otel-guard': 'src/otel-guard.ts' },
    },
    {
      deps: { resolveDepSubpath: true },
      dts: { generator: 'tsgo', tsgo: {} },
      exports: false,
      platform: 'neutral',
      entry: { 'client-layer': 'src/client-layer.ts' },
    },
    {
      deps: { resolveDepSubpath: true },
      dts: { generator: 'tsgo', tsgo: {} },
      exports: false,
      platform: 'neutral',
      entry: { 'merge-config': 'src/merge-config.ts' },
    },
  ],
  test: {
    include: ['src/**/*.test.ts'],
  },
})
