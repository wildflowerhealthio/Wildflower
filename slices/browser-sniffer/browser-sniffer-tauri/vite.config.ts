import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: {
    dts: { tsgo: {} },
    exports: false,
    platform: 'browser',
    entry: { index: 'src/index.ts' },
  },
  run: {
    // The two sniffer bootstraps are emitted into `dist/`, but `vp pack` *cleans*
    // `dist/` first — so the `build` script runs these AFTER `vp pack`. A cache
    // hit after a pack that cleaned `dist/` would leave the bundles missing and
    // the Rust `include_str!` would fail to compile (see
    // `browser-sniffer-tauri-rust/src/bootstrap.rs`), so `cache: false` forces a
    // re-emit. Kept as two single-command tasks (no `&&`) so the no-cache
    // guarantee is unambiguous per task.
    tasks: {
      'pack-tauri-bootstrap': {
        command: 'node scripts/build-tauri-bootstrap.mts',
        cache: false,
      },
      'pack-native-bootstrap': {
        command: 'node scripts/build-native-bootstrap.mts',
        cache: false,
      },
    },
  },
  test: {
    ...base.test,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
