import type { Scope } from 'effect'
import { Effect } from 'effect'
import {
  type AnyBridge,
  type BareSender,
  type BridgeSenderIntersection,
  type BridgeTransportLayers,
  makeTransport,
  type PlatformAdapter,
  type Transport,
} from 'interop-core'

/**
 * Browser-side cross-process transport. Thin wrapper around the
 * platform-agnostic {@link makeTransport} core in `interop-core`; this
 * file supplies only the Web-specific glue:
 *
 * - **Bare sender**: `window.ReactNativeWebView.postMessage(encoded)` —
 *   warns and drops when the host is absent (standalone-web bundles).
 * - **Initial-message drain**: reads `window.__INITIAL_MESSAGES__` (the
 *   pre-encoded JSON-string array the Expo host injected via
 *   `injectedJavaScriptBeforeContentLoaded`) and deletes the global so
 *   a hot reload doesn't double-replay.
 * - **Live attachment**: `window.addEventListener('message', ...)` with
 *   the standard origin/source filter. Acquired via
 *   `Effect.acquireRelease`, so the listener detaches automatically
 *   when the transport's scope closes.
 *
 * The dispatch core (handler resolution, tag-collision detection,
 * sender map, decode-then-route fiber, error formatting) lives in
 * `interop-core/transport`; tests for that pipeline live there too.
 */

/** Tuple-positional layer requirement for the Web side of every wired bridge. */
type WebTransportLayers<Bridges extends ReadonlyArray<AnyBridge>> = BridgeTransportLayers<
  Bridges,
  'Web'
>

/** Public Web transport surface — `sendMessage` + scope-managed `dispose`. */
interface WebTransport<Bridges extends ReadonlyArray<AnyBridge>> {
  readonly sendMessage: BridgeSenderIntersection<Bridges, 'Web'>
}

/** Window globals the embedded SPA observes. */
type InteropWindowGlobals = {
  /** Pre-encoded message strings the host injected before the bundle ran. */
  __INITIAL_MESSAGES__?: ReadonlyArray<string>
  /** RN-WebView bridge object. Absent when running standalone in a browser. */
  ReactNativeWebView?: { postMessage(data: string): void }
}

/**
 * Web-side {@link PlatformAdapter}.
 *
 * Reads window.__INITIAL_MESSAGES__ once (drains and deletes); attaches
 * a single message listener inside `Effect.acquireRelease` so the
 * detach runs on scope close. The bare sender warns through
 * `Effect.logWarning` (caller-controlled logger) when running outside
 * the RN-WebView host instead of throwing.
 */
const makeWebPlatformAdapter = (): PlatformAdapter => {
  const winGlobals = (): Window & InteropWindowGlobals => window as Window & InteropWindowGlobals

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
          `[interop] sendMessage: no ReactNativeWebView in window; running standalone? message dropped.`
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
        // Live transport: the RN host posts to web by injecting JS that
        // calls `window.postMessage`, so legitimate events have
        // `event.source === window` and the page's own origin. Anything
        // else (iframe, browser extension, foreign origin) is ignored.
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

/**
 * Construct a web {@link WebTransport}. The returned Effect is scoped:
 * compose with `Effect.scoped(...)` so the dispatch fiber, the queue,
 * and the window listener all release on scope close.
 *
 * Usage:
 *
 * ```ts
 * const program = Effect.scoped(
 *   Effect.gen(function*() {
 *     const transport = yield* makeWebTransport({bridges, layers})
 *     yield* transport.sendMessage({ _tag: 'RouteChanged', ... })
 *   })
 * )
 * Effect.runPromise(program.pipe(Effect.provide(loggerLayer)))
 * ```
 */
const makeWebTransport = <const Bridges extends ReadonlyArray<AnyBridge>>(config: {
  readonly bridges: Bridges
  readonly layers: WebTransportLayers<Bridges>
}): Effect.Effect<WebTransport<Bridges>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const transport: Transport<Bridges, 'Web'> = yield* makeTransport({
      bridges: config.bridges,
      layers: config.layers,
      side: 'Web',
      adapter: makeWebPlatformAdapter(),
    })
    return { sendMessage: transport.sendMessage }
  })

export { makeWebTransport }
export type { InteropWindowGlobals, WebTransport, WebTransportLayers }
