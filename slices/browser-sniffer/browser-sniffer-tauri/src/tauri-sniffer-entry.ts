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
 *
 * Control/data split: because the content webview loads untrusted third-party
 * pages, its capability (`native-webview-window.json`) withholds the bus `emit`
 * grant, so the web→host data-plane stream rides the host-gated
 * `native_webview_data_plane_emit` command (see `command-event-bus.ts`) rather
 * than `event.emit`. Inbound `Click` / `CancelSnifferRequest` still use
 * `event.listen`. Both `__TAURI__.event` and `__TAURI__.core.invoke` must be
 * present, or we no-op.
 */

import type { TauriEventApi } from 'effect-messaging-tauri'

import { makeCommandEmitEventBus } from './command-event-bus.ts'
import { makeFilteringEventBus } from './filter-tauri-internal.ts'
import { installSniffer } from './install-sniffer.ts'

type InvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>

interface TauriGlobals {
  readonly event?: TauriEventApi
  readonly core?: { readonly invoke: InvokeFn }
}

interface SnifferWindowExtensions {
  __TAURI__?: TauriGlobals
}

const win = globalThis as typeof globalThis & SnifferWindowExtensions
// oxlint-disable-next-line no-underscore-dangle -- `__TAURI__` is the Tauri 2 globals namespace.
const tauri = win.__TAURI__
const event = tauri?.event
const core = tauri?.core

if (event !== undefined && core !== undefined) {
  // Command-gated emit (data-plane out) + bus listen (control in), wrapped in
  // the FIFO / IPC-fallback-warn filter (see `filter-tauri-internal.ts`).
  // Without both halves of the bridge we no-op: shimming fetch/XHR/console with
  // no emit path just wastes cycles in arbitrary pages that load this script.
  const invoke: InvokeFn = (command, args) => core.invoke(command, args)
  installSniffer(makeFilteringEventBus(makeCommandEmitEventBus(event, invoke)))
}
