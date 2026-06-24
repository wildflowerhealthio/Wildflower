// Build-time bundler for the NATIVE sniffer bootstrap (iOS WKWebView / Android
// WebView, opened by `tauri-plugin-native-webview`).
//
// Mirrors `build-tauri-bootstrap.mts` but bundles `src/native-sniffer-entry.ts`
// (the bridge-backed transport — no `__TAURI__`, no BrowserTopBar) through the
// shared `buildBootstrap` helper. Writes:
//   - `src/native-bootstrap.generated.ts` — `string` constant for the TS
//     exports in `src/index.ts` (and the tests in `tests/`). Lives under `src/`
//     so the resolver finds it under `customConditions: ['source']`.
//   - `dist/native-bootstrap.js` — raw IIFE the host passes as the plugin's
//     `initScript` arg (a Rust crate may also `include_str!` it).
//
// Both outputs are gitignored and produced fresh on every `vp install` via the
// package's `prepare` script.

import { resolve } from 'node:path'

import { buildBootstrap } from './build-bootstrap.mts'

// `import.meta.dirname` is a string by spec (Node 20.11+).
await buildBootstrap({
  pkgRoot: resolve(import.meta.dirname, '..'),
  entryFile: 'native-sniffer-entry.ts',
  constName: 'nativeSnifferBootstrapScript',
  outBaseName: 'native-bootstrap',
  scriptName: 'build-native-bootstrap.mts',
  regenerateScript: 'generate-native-bootstrap',
})
