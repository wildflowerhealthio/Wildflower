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

/** Resolve the platform's outbound poster once (iOS, else Android, else no-op). */
const resolvePoster = (): ((message: string) => void) => {
  const win = globalThis as typeof globalThis & {
    readonly webkit?: {
      readonly messageHandlers?: {
        readonly nativeWebview?: { readonly postMessage: (message: string) => void }
      }
    }
    readonly nativeWebview?: { readonly postMessage: (message: string) => void }
  }
  const iosHandler = win.webkit?.messageHandlers?.nativeWebview
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- WKScriptMessageHandler.postMessage, not window.postMessage.
  if (iosHandler !== undefined) return (message) => iosHandler.postMessage(message)
  const androidHandler = win.nativeWebview
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Android @JavascriptInterface.postMessage, not window.postMessage.
  if (androidHandler !== undefined) return (message) => androidHandler.postMessage(message)
  return () => {}
}

/**
 * Module-scope listener registry. Shared across every
 * {@link makeNativeBridgeEventBus} call in the same JS context: the native
 * bridge has a single `window.__nativeWebviewReceive` global, so it dispatches
 * to one registry — multiple constructions read/write the same map rather than
 * orphaning the previous call's listeners (the prior behaviour silently
 * re-bound the global to a fresh map and stranded earlier `listen` calls).
 *
 * Re-installs of the receiver (e.g. after a test clears `globalThis.
 * __nativeWebviewReceive` between cases) reset this map — see
 * {@link installReceiverIfMissing} — so test isolation is preserved.
 */
const listeners = new Map<string, Set<Handler>>()

/**
 * Install `window.__nativeWebviewReceive` if it isn't already. Idempotent on
 * re-call within a context; the receiver reads `listeners` (module scope) so
 * subsequent {@link makeNativeBridgeEventBus} calls share dispatch.
 *
 * A "missing global" path also clears `listeners` so a test's `delete
 * globalThis.__nativeWebviewReceive` between cases gives a clean slate. The
 * native plugin never deletes the receiver at runtime, so this branch is
 * effectively test-only in production.
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
 * `tauri-plugin-native-webview` bridge, for use INSIDE a native popup
 * (iOS `WKWebView` / Android `android.webkit.WebView`) where `window.__TAURI__`
 * is deliberately absent.
 *
 * It is a drop-in for the `window.__TAURI__.event` bus that
 * {@link installSniffer} consumes today, so the sniffer body is reused
 * unchanged — only the transport swaps.
 *
 * Wire format (an envelope so one bridge can carry every multiplexed channel):
 *
 *   - **Web→Host** (`emit`): posts `JSON.stringify({ event, payload })` to the
 *     native handler — `window.webkit.messageHandlers.nativeWebview` on iOS,
 *     `window.nativeWebview` (an `@JavascriptInterface`) on Android. The native
 *     side forwards the string verbatim to the host webview.
 *   - **Host→Web** (`listen`): the native side calls
 *     `window.__nativeWebviewReceive(json)` with the same envelope; matching
 *     listeners receive `{ payload }`.
 *
 * The helpers (`isRecord` — shared from `./is-record.ts` — plus `parseEnvelope`
 * / `resolvePoster`) capture no state and are inlined into the esbuild IIFE, so
 * the injected document-start script stays self-contained. If no native bridge is present
 * (e.g. the page is opened outside a native popup), `emit` drops silently and
 * `listen` still registers — the sniffer simply observes nothing.
 *
 * Multiple calls in the same JS context return functionally-equivalent buses
 * sharing the module-scope listener registry — the receiver is a singleton
 * by design (one `__nativeWebviewReceive` per context).
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

export { makeNativeBridgeEventBus }
