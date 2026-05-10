import type { Scope } from 'effect'
import { Effect } from 'effect'
import {
  type BareSender,
  type TransportAdapter,
  REACT_NATIVE_WEBVIEW_GLOBAL,
  UrlCodec,
} from 'effect-messaging-core'

/** Window globals the web-side adapter observes. */
interface MessagingWindowGlobals {
  /** RN-WebView bridge object. Absent when running standalone in a browser. */
  ReactNativeWebView?: { postMessage(data: string): void }
}

/**
 * Build a {@link TransportAdapter} service for the page side: sends to
 * `window.ReactNativeWebView.postMessage`, decodes initial messages
 * from `window.location.search` URL params, and listens for live
 * `message` events with an origin/source filter.
 *
 * @remarks
 * Initial messages ride on the embed URL as `?msg.<Tag>=<base64url(JSON)>`
 * params (one per message; multi-value supported via repeated keys).
 * The host builds those params on its WebView source URL; the page
 * synchronously decodes them at boot. Once read, the params are
 * stripped via `history.replaceState` so a Fast Refresh / HMR cycle
 * does not re-dispatch them.
 *
 * Exposed as a factory (rather than baked into a transport wrapper)
 * so consumers can peek at the initial messages before mounting and
 * provide a replay adapter to `BridgeTransport.make`. See `README.md`.
 */
const make = (): TransportAdapter['Type'] => {
  const winGlobals = (): Window & MessagingWindowGlobals =>
    window as Window & MessagingWindowGlobals

  const bareSender: BareSender = (encoded) =>
    Effect.gen(function* () {
      const w = winGlobals()
      const rnBridge = w[REACT_NATIVE_WEBVIEW_GLOBAL]
      if (rnBridge !== undefined) {
        // RN-WebView's `postMessage` API differs from `window.postMessage` (no `targetOrigin`).
        // oxlint-disable-next-line eslint-plugin-unicorn/require-post-message-target-origin
        rnBridge.postMessage(encoded)
      } else {
        yield* Effect.logWarning(
          `[effect-messaging] sendMessage: no ReactNativeWebView in window; running standalone? message dropped.`
        )
      }
    })

  // Strip the `msg.*` params after read so an HMR / Fast Refresh cycle
  // doesn't re-dispatch the initial messages. Non-message params are
  // preserved untouched.
  const drainInitial: Effect.Effect<ReadonlyArray<string>> = Effect.sync(() => {
    const messages = UrlCodec.decodeMessagesFromParams(window.location.search)
    if (messages.length > 0) {
      const url = new URL(window.location.href)
      const kept = new URLSearchParams()
      for (const [k, v] of url.searchParams) {
        if (!k.startsWith(UrlCodec.PARAM_KEY_PREFIX)) kept.append(k, v)
      }
      url.search = kept.toString()
      window.history.replaceState({}, '', url.toString())
    }
    return messages
  })

  // Origin filter accepts `''` for sandboxed/file:/data: documents — see issue #24.
  const attachLive = (enqueue: (raw: string) => void): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const onMessage = (event: MessageEvent<unknown>): void => {
          if (event.source !== window) return
          if (event.origin !== window.location.origin && event.origin !== '') return
          if (typeof event.data !== 'string') return
          enqueue(event.data)
        }
        window.addEventListener('message', onMessage)
        return onMessage
      }),
      (onMessage) =>
        Effect.sync(() => {
          window.removeEventListener('message', onMessage)
        })
    ).pipe(Effect.asVoid)

  return { bareSender, drainInitial, attachLive }
}

export { make }
export type { MessagingWindowGlobals }
