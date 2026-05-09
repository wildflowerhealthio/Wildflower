import type { Scope } from 'effect'
import { Effect } from 'effect'
import {
  INITIAL_MESSAGES_WINDOW_GLOBAL,
  type BareSender,
  type PlatformAdapter,
  REACT_NATIVE_WEBVIEW_GLOBAL,
} from 'effect-messaging-core'

/**
 * Web-side {@link PlatformAdapter} factory. Re-exported as the
 * `WebPlatformAdapter` namespace from `effect-messaging-react`'s
 * barrel. Construct with {@link make}.
 *
 * @remarks
 * Exposed as a separate factory (rather than baked into a transport
 * wrapper) so consumers that need to peek at the initial messages
 * before mounting — e.g. an embedded SPA deriving an initial route —
 * can build the adapter, drain it once, and provide a replay adapter
 * that returns the same messages back through `BridgeTransport.make`'s
 * dispatch instead of double-reading the initial-messages window
 * global.
 *
 * See `README.md` for the architectural framing.
 */

/** Window globals the web-side adapter observes. */
interface MessagingWindowGlobals {
  /** Pre-encoded message strings the host injected before the bundle ran. */
  __INITIAL_MESSAGES__?: ReadonlyArray<string>
  /** RN-WebView bridge object. Absent when running standalone in a browser. */
  ReactNativeWebView?: { postMessage(data: string): void }
}

/**
 * Build a {@link PlatformAdapter} service that sends to
 * `window.ReactNativeWebView.postMessage`, drains
 * `window.__INITIAL_MESSAGES__` once, and listens for live
 * `message` events with an origin/source filter.
 */
const make = (): PlatformAdapter['Type'] => {
  const winGlobals = (): Window & MessagingWindowGlobals =>
    window as Window & MessagingWindowGlobals

  const bareSender: BareSender = (encoded) =>
    Effect.gen(function* () {
      const w = winGlobals()
      const rnBridge = w[REACT_NATIVE_WEBVIEW_GLOBAL]
      if (rnBridge !== undefined) {
        // RN-WebView's `postMessage` doesn't take a `targetOrigin` —
        // different API surface from `window.postMessage`.
        // oxlint-disable-next-line eslint-plugin-unicorn/require-post-message-target-origin
        rnBridge.postMessage(encoded)
      } else {
        yield* Effect.logWarning(
          `[effect-messaging] sendMessage: no ReactNativeWebView in window; running standalone? message dropped.`
        )
      }
    })

  /**
   * Drain `window.__INITIAL_MESSAGES__` once and delete the global so
   * a hot reload can't double-replay. Non-string entries are filtered
   * out — the host writes only encoded strings, but the global is
   * untrusted.
   */
  const drainInitial: Effect.Effect<ReadonlyArray<string>> = Effect.sync(() => {
    const w = winGlobals()
    const initial = w[INITIAL_MESSAGES_WINDOW_GLOBAL]
    if (!Array.isArray(initial)) return []
    delete w[INITIAL_MESSAGES_WINDOW_GLOBAL]
    return initial.filter((entry): entry is string => typeof entry === 'string')
  })

  /**
   * Wire `window.addEventListener('message', ...)` into `enqueue`.
   * The acquireRelease detaches the listener on scope close. The
   * filter accepts events whose `source === window` and whose
   * `origin` matches the page origin OR is `''` (sandboxed/file:/data:
   * documents — see issue #24 for threat model).
   */
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
