// Build-time bundler for the NATIVE sniffer bootstrap (iOS WKWebView / Android
// WebView, opened by `tauri-plugin-native-webview`): bundles
// `src/native-sniffer-entry.ts` (bridge-backed transport, no `__TAURI__`)
// through the shared `buildBootstrap` helper. See `build-bootstrap.mts` for the
// outputs written and why.

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
