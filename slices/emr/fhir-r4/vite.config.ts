import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
      entry: { 'clients/index': 'src/clients/index.ts' },
    },
    {
      deps: { resolveDepSubpath: true },
      dts: { generator: 'tsgo', tsgo: {} },
      exports: false,
      platform: 'neutral',
      entry: { 'http-api-definition/index': 'src/http-api-definition/index.ts' },
    },
    {
      deps: { resolveDepSubpath: true },
      dts: { generator: 'tsgo', tsgo: {} },
      exports: false,
      platform: 'neutral',
      entry: { 'identity/index': 'src/identity/index.ts' },
    },
    {
      deps: { resolveDepSubpath: true },
      dts: { generator: 'tsgo', tsgo: {} },
      exports: false,
      platform: 'neutral',
      entry: { 'resources/index': 'src/resources/index.ts' },
    },
    {
      deps: { resolveDepSubpath: true },
      dts: { generator: 'tsgo', tsgo: {} },
      exports: false,
      platform: 'neutral',
      entry: { 'data-types/index': 'src/data-types/index.ts' },
    },
    {
      deps: { resolveDepSubpath: true },
      dts: { generator: 'tsgo', tsgo: {} },
      exports: false,
      platform: 'neutral',
      entry: { 'telemetry/index': 'src/telemetry/index.ts' },
    },
  ],
  test: {
    setupFiles: [
      path.join(path.dirname(fileURLToPath(import.meta.url)), '/vitest.setupSchemaEqual.ts'),
    ],
    testTimeout: 120_000,
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
