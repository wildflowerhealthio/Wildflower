// Entry point bundled by `scripts/build-tauri-bootstrap.mts` into the IIFE
// injected into Tauri sniffer webviews via `initialization_script(...)` —
// today that's the `tauri-plugin-native-webview` plugin's desktop content
// webview (the plugin's chrome bar above the content provides title,
// subtitle, message and back/forward/refresh, so this bootstrap stays
// content-only — no in-page top bar like the pre-plugin path needed).
//
// `window.__TAURI__` is present because `tauri.conf.json` sets
// `app.withGlobalTauri: true`, which Tauri prepends to every webview's
// init scripts at runtime — no per-builder opt-in needed.

import type { TauriEventApi } from 'effect-messaging-tauri'

import { makeFilteringEventBus } from './filter-tauri-internal.ts'
import { installSniffer } from './install-sniffer.ts'

interface TauriGlobals {
  readonly event?: TauriEventApi
}

interface SnifferWindowExtensions {
  __TAURI__?: TauriGlobals
}

const win = globalThis as typeof globalThis & SnifferWindowExtensions
// oxlint-disable-next-line no-underscore-dangle -- `__TAURI__` is the Tauri 2 globals namespace.
const event = win.__TAURI__?.event

if (event !== undefined) {
  // Wrap the raw Tauri event bus through the FIFO/Tauri-IPC-fallback-warn
  // filter, then hand it to `installSniffer`. Without a working event bus
  // we no-op — the bootstrap can't carry sniffer traffic and shimming
  // fetch/XHR/console without an emit path just wastes cycles in arbitrary
  // pages that may happen to load this script.
  installSniffer(makeFilteringEventBus(event))
}
