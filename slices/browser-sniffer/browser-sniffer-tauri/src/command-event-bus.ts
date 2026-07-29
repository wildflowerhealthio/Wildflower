import type { TauriEventApi } from 'effect-messaging-tauri'

import { BRIDGE_EVENT } from './install-sniffer.ts'

/** The `__TAURI__.core.invoke` shape this module needs (command name + args). */
type InvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>

/**
 * Host command (browser-sniffer-tauri-rust) the desktop content webview's
 * web→host data-plane stream rides instead of a direct `event.emit`. The host
 * allowlists the inner `_tag` before publishing into the sniffer event stream;
 * see `capabilities/native-webview-window.json`.
 */
const DATA_PLANE_EMIT_COMMAND = 'native_webview_data_plane_emit'

/**
 * Build a {@link TauriEventApi} for the DESKTOP sniffer content webview whose
 * outbound {@link BRIDGE_EVENT} emits go through the host-gated
 * {@link DATA_PLANE_EMIT_COMMAND} command rather than `event.emit`, while
 * inbound messages arrive through the caller-supplied `listen` — the
 * `window.__nativeWebviewReceive` receiver the host's `evaluate_js` forward
 * calls (see `native-bridge.ts`), the same inbound path mobile uses.
 *
 * @remarks Desktop half of the control/data split: the content webview loads
 * arbitrary third-party content, so its capability grants NO event-bus
 * permissions at all (no per-event-name scope — a hostile page could forge
 * control tags). The command is the only sanctioned page→host emit path and
 * allowlists the inner `_tag` host-side; inbound `PageAction` /
 * `CancelSnifferRequest` arrive via a Rust-initiated `evaluate_js`, which a
 * page script can't spoof. Wrapped by `makeFilteringEventBus` (FIFO + `Log`
 * IPC-fallback drop) so streaming `ResponseData` chunks stay ordered.
 */
const makeCommandEmitEventBus = (
  listen: TauriEventApi['listen'],
  invoke: InvokeFn
): TauriEventApi => ({
  emit: (eventName, payload) => {
    // The sniffer only multiplexes BRIDGE_EVENT; without a bus `emit` grant any
    // other name has no transport, so drop it rather than reach for one that
    // would be rejected.
    if (eventName !== BRIDGE_EVENT) return Promise.resolve()
    return invoke(DATA_PLANE_EMIT_COMMAND, { payload }).then(() => undefined)
  },
  // Arrow (not a bare reference) so a stateful `listen` keeps its receiver.
  listen: (eventName, handler) => listen(eventName, handler),
})

export { DATA_PLANE_EMIT_COMMAND, makeCommandEmitEventBus }
