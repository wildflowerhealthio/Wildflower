import type { Scope } from 'effect'
import { Effect } from 'effect'
import {
  INITIAL_MESSAGES_WINDOW_GLOBAL,
  type BareSender,
  type TransportAdapter,
  REACT_NATIVE_WEBVIEW_GLOBAL,
} from 'effect-messaging-core'

/** Window globals the web-side adapter observes. */
interface MessagingWindowGlobals {
  /** Pre-encoded message strings the host injected before the bundle ran. */
  __INITIAL_MESSAGES__?: ReadonlyArray<string>
  /** RN-WebView bridge object. Absent when running standalone in a browser. */
  ReactNativeWebView?: { postMessage(data: string): void }
}

/**
 * Build a {@link TransportAdapter} service for the page side: sends to
 * `window.ReactNativeWebView.postMessage`, drains
 * `window.__INITIAL_MESSAGES__` once, and listens for live `message`
 * events with an origin/source filter.
 *
 * @remarks
 * Exposed as a factory (rather than baked into a transport wrapper) so
 * consumers can peek at the initial messages before mounting and provide
 * a replay adapter to `BridgeTransport.make`. See `README.md`.
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

  // Delete the global after read so a hot reload can't double-replay.
  const drainInitial: Effect.Effect<ReadonlyArray<string>> = Effect.sync(() => {
    const w = winGlobals()
    const initial = w[INITIAL_MESSAGES_WINDOW_GLOBAL]
    if (!Array.isArray(initial)) return []
    delete w[INITIAL_MESSAGES_WINDOW_GLOBAL]
    return initial.filter((entry): entry is string => typeof entry === 'string')
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
