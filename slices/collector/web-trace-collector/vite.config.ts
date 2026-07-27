import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: {
    dts: { tsgo: true },
    exports: false,
    // Ships a React config form alongside the capture logic, so it packs for
    // the browser (like the other `*-client-collector`s).
    platform: 'browser',
    entry: { index: 'src/index.ts' },
  },
  test: {
    // `...base.test` is load-bearing for every jsdom package — it carries the
    // `--no-experimental-webstorage` execArgv that stops Node 26's inert global
    // `localStorage` from shadowing jsdom's. See the Testing Reference.
    ...base.test,
    // jsdom for the config-form component test.
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
