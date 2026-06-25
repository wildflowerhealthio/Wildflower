/**
 * Entry point bundled by `scripts/build-tauri-bootstrap.mts` into the IIFE
 * injected into Tauri sniffer webviews via `initialization_script(...)` — today
 * the `tauri-plugin-native-webview` plugin's desktop content webview. The
 * plugin's chrome bar above the content owns title/subtitle/message +
 * back/forward/refresh, so this bootstrap stays content-only.
 *
 * `window.__TAURI__` is present because `tauri.conf.json` sets
 * `app.withGlobalTauri: true`, which Tauri prepends to every webview's init
 * scripts at runtime — no per-builder opt-in needed.
 */

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
  // Wrap the raw Tauri event bus through the FIFO / IPC-fallback-warn filter
  // (see `filter-tauri-internal.ts`). Without an event bus we no-op: shimming
  // fetch/XHR/console with no emit path just wastes cycles in arbitrary pages
  // that happen to load this script.
  installSniffer(makeFilteringEventBus(event))
}
