import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: [
    {
      dts: { tsgo: {} },
      exports: false,
      platform: 'neutral',
      entry: { index: 'src/index.ts' },
    },
    {
      dts: { tsgo: {} },
      exports: false,
      platform: 'neutral',
      entry: { 'otel-guard': 'src/otel-guard.ts' },
    },
    {
      dts: { tsgo: {} },
      exports: false,
      platform: 'neutral',
      entry: { 'client-layer': 'src/client-layer.ts' },
    },
    {
      dts: { tsgo: {} },
      exports: false,
      platform: 'neutral',
      entry: { 'merge-config': 'src/merge-config.ts' },
    },
  ],
  test: {
    include: ['src/**/*.test.ts'],
  },
})
