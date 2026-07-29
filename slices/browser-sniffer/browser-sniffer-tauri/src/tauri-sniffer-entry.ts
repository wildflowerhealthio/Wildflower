/**
 * Entry point bundled by `scripts/build-tauri-bootstrap.mts` into the IIFE
 * injected into Tauri sniffer webviews via `initialization_script(...)` — today
 * the `tauri-plugin-native-webview` plugin's desktop content webview.
 *
 * `window.__TAURI__` is present because `tauri.conf.json` sets
 * `app.withGlobalTauri: true`, which Tauri prepends to every webview's init
 * scripts at runtime — but this entry only needs `__TAURI__.core.invoke`.
 *
 * For the control/data split (outbound rides the host-gated
 * `native_webview_data_plane_emit` command, inbound rides the
 * `window.__nativeWebviewReceive` receiver the host's `evaluate_js` forward
 * calls), see `command-event-bus.ts` and `native-bridge.ts`. Without
 * `__TAURI__.core.invoke` we no-op.
 */

import { makeCommandEmitEventBus } from './command-event-bus.ts'
import { makeFilteringEventBus } from './filter-tauri-internal.ts'
import { installSniffer } from './install-sniffer.ts'
import { makeNativeBridgeEventBus } from './native-bridge.ts'

type InvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>

interface TauriGlobals {
  readonly core?: { readonly invoke: InvokeFn }
}

interface SnifferWindowExtensions {
  __TAURI__?: TauriGlobals
}

const win = globalThis as typeof globalThis & SnifferWindowExtensions
// oxlint-disable-next-line no-underscore-dangle -- `__TAURI__` is the Tauri 2 globals namespace.
const core = win.__TAURI__?.core

if (core !== undefined) {
  // Command-gated emit (data-plane out) + `__nativeWebviewReceive` listen
  // (host-forwarded `PageAction` / `CancelSnifferRequest` in — the receiver
  // registry from `native-bridge.ts`; its poster half no-ops on desktop, we
  // only take `listen`). Wrapped in the FIFO / IPC-fallback-warn filter (see
  // `filter-tauri-internal.ts`).
  const invoke: InvokeFn = (command, args) => core.invoke(command, args)
  const receiverBus = makeNativeBridgeEventBus()
  installSniffer(makeFilteringEventBus(makeCommandEmitEventBus(receiverBus.listen, invoke)))
}
