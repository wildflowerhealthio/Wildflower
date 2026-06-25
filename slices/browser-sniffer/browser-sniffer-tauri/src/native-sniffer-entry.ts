// Entry point bundled by `scripts/build-native-bootstrap.mts` into the IIFE the
// `tauri-plugin-native-webview` plugin injects (as its `initScript` arg) at
// document start in a native webview (iOS WKWebView / Android WebView).
//
// Unlike `tauri-sniffer-entry.ts` there is no `window.__TAURI__` — we build
// the bridge-backed event bus (`makeNativeBridgeEventBus`) and run the same
// `installSniffer` body over it. Neither entry injects in-page chrome any
// more; the plugin's native toolbar (iOS / Android) and its multi-webview
// chrome bar (desktop) own the title/subtitle/message + nav buttons.
//
// Gated on the native bridge being present so the script no-ops if it is ever
// injected somewhere without the plugin's message handler (nothing to send to).

import { installSniffer } from './install-sniffer.ts'
import { hasNativeBridge, makeNativeBridgeEventBus } from './native-bridge.ts'

// Gate on the same bridge resolution the transport uses (`hasNativeBridge` and
// `resolvePoster` both derive from `native-bridge.ts`'s `resolveBridgeTarget`),
// so the entry can't no-op on one shape while the poster would have resolved
// another.
if (hasNativeBridge()) {
  // No filtering wrapper here: the Tauri IPC-fallback `console.warn` the
  // desktop entry strips is a `__TAURI__` artifact that can't occur in a native
  // webview, and the native bridge's `postMessage` is synchronous, so emits are
  // already FIFO without the desktop entry's serialising promise chain.
  installSniffer(makeNativeBridgeEventBus())
}
