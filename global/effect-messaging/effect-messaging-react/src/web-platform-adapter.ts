import type { Scope } from 'effect'
import { Effect } from 'effect'
import { type BareSender, type PlatformAdapter } from 'effect-messaging-core'

/**
 * Web-side {@link PlatformAdapter} factory — builds the service the
 * `Context.Tag` is supplied with.
 *
 * - **Bare sender**: `window.ReactNativeWebView.postMessage(encoded)`
 *   — warns and drops when the host is absent (standalone-web
 *   bundles).
 * - **Initial-message drain**: reads `window.__INITIAL_MESSAGES__`
 *   (the pre-encoded JSON-string array the Expo host injected via
 *   `injectedJavaScriptBeforeContentLoaded`) and deletes the global
 *   so a hot reload doesn't double-replay.
 * - **Live attachment**: `window.addEventListener('message', ...)`
 *   with the standard origin/source filter. Acquired via
 *   `Effect.acquireRelease`, so the listener detaches automatically
 *   when the transport's scope closes.
 *
 * Re-exported as the `WebPlatformAdapter` namespace from
 * `effect-messaging-react`'s barrel. Construct with {@link make}.
 *
 * Exposed as a separate factory (rather than baked into the
 * transport) so consumers that need to peek at the initial messages
 * before mounting — e.g. an embedded SPA deriving an initial route —
 * can build the adapter, drain it once, and provide a replay adapter
 * Layer that returns the same messages back through
 * `WebTransport.make`'s dispatch instead of double-reading
 * `window.__INITIAL_MESSAGES__`.
 */

/** Window globals the web-side adapter observes. */
interface MessagingWindowGlobals {
  /** Pre-encoded message strings the host injected before the bundle ran. */
  __INITIAL_MESSAGES__?: ReadonlyArray<string>
  /** RN-WebView bridge object. Absent when running standalone in a browser. */
  ReactNativeWebView?: { postMessage(data: string): void }
}

const make = (): PlatformAdapter['Type'] => {
  const winGlobals = (): Window & MessagingWindowGlobals =>
    window as Window & MessagingWindowGlobals

  const bareSender: BareSender = (encoded) =>
    Effect.gen(function* () {
      const w = winGlobals()
      if (w.ReactNativeWebView !== undefined) {
        // RN-WebView's `postMessage` doesn't take a `targetOrigin` —
        // different API surface from `window.postMessage`.
        // oxlint-disable-next-line eslint-plugin-unicorn/require-post-message-target-origin
        w.ReactNativeWebView.postMessage(encoded)
      } else {
        yield* Effect.logWarning(
          `[effect-messaging] sendMessage: no ReactNativeWebView in window; running standalone? message dropped.`
        )
      }
    })

  const drainInitial: Effect.Effect<ReadonlyArray<string>> = Effect.sync(() => {
    const w = winGlobals()
    const initial = w.__INITIAL_MESSAGES__
    if (!Array.isArray(initial)) return []
    delete w.__INITIAL_MESSAGES__
    return initial.filter((entry): entry is string => typeof entry === 'string')
  })

  const attachLive = (enqueue: (raw: string) => void): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.sync(() => {
        // Live transport: the RN host posts to web by injecting JS
        // that calls `window.postMessage`, so legitimate events have
        // `event.source === window` and the page's own origin.
        // Anything else (iframe, browser extension, foreign origin)
        // is ignored.
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
