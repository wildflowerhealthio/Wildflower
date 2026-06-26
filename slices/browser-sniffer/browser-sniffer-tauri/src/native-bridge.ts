// oxlint-disable no-underscore-dangle
import type { TauriEventApi } from 'effect-messaging-tauri'

import { isRecord } from './is-record.ts'

/** Wire envelope carried over the native bridge: which channel + its payload. */
type Envelope = { readonly event: string; readonly payload: unknown }
type Handler = (event: { readonly payload: unknown }) => void

/** Parse an inbound envelope; `undefined` for anything malformed. */
const parseEnvelope = (json: string): Envelope | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const event = parsed.event
  if (typeof event !== 'string') return undefined
  return { event, payload: parsed.payload }
}

/** A native message handler exposed on the page — same `postMessage` shape on
 *  both platforms (iOS `WKScriptMessageHandler`, Android `@JavascriptInterface`). */
type NativeBridgeTarget = { readonly postMessage: (message: string) => void }

/** The native-bridge globals the plugin injects, if present in this context. */
type NativeBridgeGlobals = typeof globalThis & {
  readonly webkit?: { readonly messageHandlers?: { readonly nativeWebview?: NativeBridgeTarget } }
  readonly nativeWebview?: NativeBridgeTarget
}

/**
 * Resolve the platform's native bridge handler (iOS first, then Android), or
 * `undefined` when neither is present (page isn't inside a native webview).
 *
 * @remarks Single source of truth so {@link resolvePoster} (outbound) and
 * {@link hasNativeBridge} (presence gate) can't desync on a handler-name change.
 */
const resolveBridgeTarget = (): NativeBridgeTarget | undefined => {
  const win = globalThis as NativeBridgeGlobals
  return win.webkit?.messageHandlers?.nativeWebview ?? win.nativeWebview
}

/** Whether a native bridge handler (iOS or Android) is present in this context. */
const hasNativeBridge = (): boolean => resolveBridgeTarget() !== undefined

/** Resolve the outbound poster: the native handler's `postMessage`, else no-op. */
const resolvePoster = (): ((message: string) => void) => {
  const target = resolveBridgeTarget()
  if (target === undefined) return () => {}
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- WKScriptMessageHandler / Android @JavascriptInterface postMessage, not window.postMessage.
  return (message) => target.postMessage(message)
}

/**
 * Module-scope listener registry, shared across every
 * {@link makeNativeBridgeEventBus} call in the same JS context. The single
 * `window.__nativeWebviewReceive` global dispatches to one registry, so the
 * receiver is a singleton by design — multiple constructions read/write this map
 * rather than orphaning earlier `listen` calls.
 *
 * Cleared whenever the receiver is (re)installed; see
 * {@link installReceiverIfMissing}.
 */
const listeners = new Map<string, Set<Handler>>()

/**
 * Install `window.__nativeWebviewReceive` if absent (idempotent per context).
 * The receiver reads the module-scope {@link listeners} so subsequent
 * {@link makeNativeBridgeEventBus} calls share dispatch.
 *
 * @remarks The install path clears {@link listeners}: the native plugin never
 * deletes the receiver at runtime, so this only fires on a test reset.
 */
const installReceiverIfMissing = (): void => {
  const receiverHost = globalThis as typeof globalThis & {
    __nativeWebviewReceive?: (json: string) => void
  }
  if (receiverHost.__nativeWebviewReceive !== undefined) return
  listeners.clear()
  // oxlint-disable-next-line no-underscore-dangle -- the native plugin calls this exact global.
  receiverHost.__nativeWebviewReceive = (json: string): void => {
    const envelope = parseEnvelope(json)
    if (envelope === undefined) return
    const handlers = listeners.get(envelope.event)
    if (handlers === undefined) return
    // Snapshot so an unlisten fired during dispatch can't skip a sibling handler.
    const snapshot = Array.from(handlers)
    for (const handler of snapshot) handler({ payload: envelope.payload })
  }
}

/**
 * Build a {@link TauriEventApi}-shaped event bus backed by the
 * `tauri-plugin-native-webview` bridge, for use INSIDE a native webview
 * (iOS `WKWebView` / Android `android.webkit.WebView`) where `window.__TAURI__`
 * is deliberately absent. A drop-in for the `window.__TAURI__.event` bus
 * {@link installSniffer} consumes, so the sniffer body is reused unchanged —
 * only the transport swaps.
 *
 * @remarks Wire format ({@link Envelope}, so one bridge carries every
 * multiplexed channel):
 *
 *   - **Web→Host** (`emit`): posts `JSON.stringify({ event, payload })` to the
 *     native handler — `window.webkit.messageHandlers.nativeWebview` on iOS,
 *     `window.nativeWebview` (an `@JavascriptInterface`) on Android.
 *   - **Host→Web** (`listen`): the native side calls
 *     `window.__nativeWebviewReceive(json)` with the same envelope; matching
 *     listeners receive `{ payload }`.
 *
 * Outside a native webview, `emit` drops silently and `listen` still registers —
 * the sniffer observes nothing. Multiple calls in one JS context share the
 * module-scope {@link listeners} registry.
 */
const makeNativeBridgeEventBus = (): TauriEventApi => {
  const post = resolvePoster()
  installReceiverIfMissing()
  return {
    emit: (event, payload) => {
      post(JSON.stringify({ event, payload } satisfies Envelope))
      return Promise.resolve()
    },
    listen: (event, handler) => {
      const set = listeners.get(event) ?? new Set<Handler>()
      set.add(handler)
      listeners.set(event, set)
      return Promise.resolve(() => {
        set.delete(handler)
        if (set.size === 0) listeners.delete(event)
      })
    },
  }
}

export { hasNativeBridge, makeNativeBridgeEventBus }
