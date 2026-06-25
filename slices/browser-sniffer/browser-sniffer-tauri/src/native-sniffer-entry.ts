/**
 * Entry point bundled by `scripts/build-native-bootstrap.mts` into the IIFE the
 * `tauri-plugin-native-webview` plugin injects (as its `initScript` arg) at
 * document start in a native webview (iOS WKWebView / Android WebView).
 *
 * Unlike `tauri-sniffer-entry.ts` there is no `window.__TAURI__`: we build the
 * bridge-backed event bus (`makeNativeBridgeEventBus`) and run the same
 * `installSniffer` body over it. No in-page chrome is injected — the plugin's
 * native toolbar owns the title/subtitle/message + nav buttons.
 *
 * Gated on the native bridge so the script no-ops if injected somewhere without
 * the plugin's message handler (nothing to send to).
 */

import { installSniffer } from './install-sniffer.ts'
import { hasNativeBridge, makeNativeBridgeEventBus } from './native-bridge.ts'

if (hasNativeBridge()) {
  // No filtering wrapper here (unlike the desktop entry): the Tauri IPC-fallback
  // `console.warn` it strips is a `__TAURI__` artifact that can't occur in a
  // native webview, and the bridge's `postMessage` is synchronous so emits are
  // already FIFO without the desktop entry's serializing promise chain.
  installSniffer(makeNativeBridgeEventBus())
}
