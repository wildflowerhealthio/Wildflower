/**
 * Entry point bundled by `scripts/build-native-bootstrap.mts` into the IIFE the
 * `tauri-plugin-native-webview` plugin injects (as its `initScript` arg) at
 * document start in a native webview (iOS WKWebView / Android WebView).
 *
 * Unlike `tauri-sniffer-entry.ts` there is no `window.__TAURI__`: we build the
 * bridge-backed event bus (`makeNativeBridgeEventBus`) and run the same
 * `installSniffer` body over it. Gated on the native bridge, so it no-ops if
 * injected somewhere without the plugin's message handler.
 */

import { installSniffer } from './install-sniffer.ts'
import { hasNativeBridge, makeNativeBridgeEventBus } from './native-bridge.ts'

if (hasNativeBridge()) {
  // No filtering wrapper (unlike the desktop entry): the IPC-fallback
  // `console.warn` it strips is a `__TAURI__` artifact absent here, and the
  // bridge's synchronous `postMessage` is already FIFO without the desktop
  // entry's serializing promise chain.
  installSniffer(makeNativeBridgeEventBus())
}
