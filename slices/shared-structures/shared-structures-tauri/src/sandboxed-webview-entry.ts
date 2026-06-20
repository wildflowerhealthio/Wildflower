// Entry point bundled by `scripts/build-tauri-bootstrap.mts` into the IIFE
// injected into the sandboxed webview via `initialization_script(...)` (see
// shared-structures-tauri-rust's `sandboxed_webview`). Looks up Tauri's event
// API and injects the in-page browser top bar with a Back/Reload/URL chrome.
//
// `window.__TAURI__` is present because the host's `tauri.conf.json` sets
// `app.withGlobalTauri: true`, which Tauri prepends to every webview's init
// scripts at runtime.
//
// Unlike the sniffer bootstrap there is no fetch/XHR/console shim and no
// outbound stream, so the raw Tauri event bus is used directly — no filtering
// wrapper is needed.

import type { TauriEventApi } from 'effect-messaging-tauri'

import { BRIDGE_EVENT, CLOSE_SANDBOXED_WEBVIEW_TAG } from './bridge-tags.ts'
import { injectBrowserTopBar } from './inject-browser-top-bar.ts'

interface TauriGlobals {
  readonly event?: TauriEventApi
}

interface SandboxedWindowExtensions {
  __TAURI__?: TauriGlobals
}

const win = globalThis as typeof globalThis & SandboxedWindowExtensions
// oxlint-disable-next-line no-underscore-dangle -- `__TAURI__` is the Tauri 2 globals namespace.
const event = win.__TAURI__?.event

if (event !== undefined) {
  injectBrowserTopBar({
    hostId: 'wildflower-sandboxed-webview-top-bar',
    observerSlotKey: Symbol.for('shared-structures-tauri:top-bar-observer'),
    primary: 'back',
    showReload: true,
    reserveSpace: true,
    // Back with no history left, or a future Close, asks the host to tear the
    // window down. Best-effort emit on the multiplexed bridge channel;
    // `CloseSandboxedWebView` carries an empty struct beyond the `_tag`.
    onExit: () => {
      void event.emit(BRIDGE_EVENT, { _tag: CLOSE_SANDBOXED_WEBVIEW_TAG })
    },
  })
}
