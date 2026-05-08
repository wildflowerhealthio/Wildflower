import { Context, type Effect, type Scope } from 'effect'

/**
 * Process-side glue the transport leans on. Each platform adapter
 * supplies three pieces:
 *
 * - {@link Service.bareSender}: writes one already-encoded string out —
 *   the browser's `window.ReactNativeWebView.postMessage` on the page
 *   side, the WebView ref's imperative `postMessage` on the host side.
 *   Returns an Effect so platform-level failures (no host bridge
 *   present, no WebView mounted yet) compose into the caller's logger.
 * - {@link Service.drainInitial}: returns the pre-existing
 *   initial-message strings the host injected before the bundle ran.
 *   The web adapter drains `window.__INITIAL_MESSAGES__` and deletes
 *   it; the host adapter has no inbound initial messages and returns
 *   an empty array.
 * - {@link Service.attachLive} (optional): the web adapter wires
 *   `window.addEventListener('message', ...)` into the supplied
 *   `enqueue` callback inside `Effect.acquireRelease` so the listener
 *   detaches on scope close. The host adapter omits this — the
 *   consumer wires the WebView's `onMessage` prop to the transport's
 *   exposed `enqueue` directly.
 *
 * Aggregators provide the adapter via
 * `Layer.succeed(PlatformAdapter, ...)`. The bridge senders and the
 * transport core both read from the same `Context.Tag`, so the same
 * `Bridge.make`-built sender encodes against either a live byte sink
 * or a capturing test stub without changing the call site.
 */

/**
 * Writes one encoded message string to the underlying transport.
 *
 * Effect-typed so platform implementations can fail (no host bridge
 * present, etc.) and so callers compose the send into larger Effect
 * programs without an `Effect.runSync` boundary at every site.
 */
type BareSender = (encoded: string) => Effect.Effect<void>

/**
 * Service shape supplied at the {@link PlatformAdapter} `Context.Tag`.
 * Callers that need to type the value (when constructing a custom
 * adapter, etc.) reach for `PlatformAdapter['Type']` rather than a
 * separate alias — there's only one source of truth.
 */
interface Service {
  readonly bareSender: BareSender
  readonly drainInitial: Effect.Effect<ReadonlyArray<string>>
  readonly attachLive?: (enqueue: (raw: string) => void) => Effect.Effect<void, never, Scope.Scope>
}

/**
 * `Context.Tag` for the platform adapter. Aggregators (web/expo
 * wrappers, tests) provide it via `Layer.succeed(PlatformAdapter, ...)`.
 */
class PlatformAdapter extends Context.Tag('@effect-messaging/PlatformAdapter')<
  PlatformAdapter,
  Service
>() {}

export { PlatformAdapter }
export type { BareSender }
