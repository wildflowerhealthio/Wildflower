import type { Scope } from 'effect'
import { Effect } from 'effect'
import {
  type BareSenderFunction,
  type Bridge,
  type TransportAdapter,
  REACT_NATIVE_WEBVIEW_GLOBAL,
  UrlParamMessage,
} from 'effect-messaging-core'

/** Window globals the web-side adapter observes. */
interface MessagingWindowGlobals {
  /** RN-WebView bridge object. Absent when running standalone in a browser. */
  ReactNativeWebView?: { postMessage(data: string): void }
}

const winGlobals = (): Window & MessagingWindowGlobals => window

/**
 * Build a {@link TransportAdapter} service for the page side.
 *
 * - **bareSender**: posts to `window.ReactNativeWebView.postMessage`;
 *   warns and drops when running standalone (no host to receive).
 * - **drainInitial**: parses `?<Tag>=<value>` URL params using the
 *   supplied bridges' `urlParams` schemas and returns the wire-JSON
 *   form for each decoded message. Bridge params are stripped from the
 *   URL via `history.replaceState` so a Fast Refresh / HMR cycle does
 *   not re-dispatch them. Non-bridge params (third-party tracking,
 *   routing fragments) are preserved.
 * - **attachBareSender**: listens for live `message` events with origin/source filtering.
 *
 * @remarks
 * The adapter takes the bridges so it can drive URL-param decoding
 * without coupling the dispatch core to URL semantics. A bridge with
 * no `urlParams` schemas contributes nothing to drainInitial.
 */
const make = (bridges: ReadonlyArray<Bridge.AnyBridge>): TransportAdapter['Type'] => {
  const bareSender: BareSenderFunction = (encoded) =>
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

  const drainInitial: Effect.Effect<ReadonlyArray<string>> = Effect.sync(() => {
    const search = window.location.search
    const messages = UrlParamMessage.reEncodeMessagesFromParams(search, bridges)
    if (messages.length > 0) {
      const url = new URL(window.location.href)
      url.search = UrlParamMessage.stripMessageParams(search, bridges)
      window.history.replaceState({}, '', url.toString())
    }
    return messages
  })

  // Origin filter accepts `''` for sandboxed/file:/data: documents — see issue #24.
  // Source filter accepts `null` only when the page is hosted inside RN-WebView:
  // its iOS native dispatch builds a MessageEvent without a source or origin,
  // so a strict `source !== window` check would drop every host→web message
  // on iOS. The `ReactNativeWebView` presence check is the co-signing condition
  // so synthesized null-source events from foreign sandboxed pages stay rejected.
  const attachBareSender = (
    otherBareSender: BareSenderFunction
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const onMessageEffect = (event: MessageEvent<unknown>): Effect.Effect<void> => {
          const inRNWebView = winGlobals()[REACT_NATIVE_WEBVIEW_GLOBAL] !== undefined
          const isAdmissibleSource =
            event.source === window || (event.source === null && inRNWebView)
          if (!isAdmissibleSource) return Effect.void
          if (event.origin !== window.location.origin && event.origin !== '') return Effect.void
          if (typeof event.data !== 'string') return Effect.void
          return otherBareSender(event.data)
        }
        const onMessage = (event: MessageEvent<unknown>): Promise<void> =>
          Effect.runPromise(onMessageEffect(event))
        window.addEventListener('message', onMessage)
        return onMessage
      }),
      (onMessage) =>
        Effect.sync(() => {
          window.removeEventListener('message', onMessage)
        })
    ).pipe(Effect.asVoid)

  return { bareSender, drainInitial, attachBareSender }
}

export { make }
export type { MessagingWindowGlobals }
