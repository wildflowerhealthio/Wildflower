import { Context, type Effect, type Scope } from 'effect'

/**
 * Process-side glue the transport leans on. Each platform adapter
 * supplies a sender, an initial-message drainer, and (optionally) a
 * live-attach Effect that wires platform events into the transport's
 * dispatch fiber.
 */

/** Wire-format constant — the page-side global the host pre-populates. */
const INITIAL_MESSAGES_WINDOW_GLOBAL = '__INITIAL_MESSAGES__' as const

/** Wire-format constant — the RN-WebView bridge object name on `window`. */
const REACT_NATIVE_WEBVIEW_GLOBAL = 'ReactNativeWebView' as const

/**
 * Writes one encoded message string to the underlying transport.
 * Effect-typed so platform implementations can fail (no host bridge
 * present, etc.) and so callers compose the send into larger Effect
 * programs without an `Effect.runSync` boundary at every site.
 */
type BareSender = (encoded: string) => Effect.Effect<void>

/** Service shape supplied at the {@link PlatformAdapter} `Context.Tag`. */
interface Service {
  /** Send one already-encoded string to the other process. */
  readonly bareSender: BareSender
  /** Pre-existing initial-message strings the host injected before the bundle ran. */
  readonly drainInitial: Effect.Effect<ReadonlyArray<string>>
  /**
   * Wire the platform's live-message source into `enqueue`. Acquired
   * via `Effect.acquireRelease` so the listener detaches on scope
   * close. Optional — the Expo host adapter omits this and the
   * consumer wires the WebView's `onMessage` prop manually.
   */
  readonly attachLive?: (enqueue: (raw: string) => void) => Effect.Effect<void, never, Scope.Scope>
}

/**
 * `Context.Tag` for the platform adapter. Aggregators (web/expo
 * wrappers, tests) provide it via
 * `Layer.succeed(PlatformAdapter, ...)`. The bridge senders and the
 * transport core both read from this tag, so the same `Bridge.make`-
 * built sender encodes against either a live byte sink or a
 * capturing test stub.
 */
class PlatformAdapter extends Context.Tag('@effect-messaging/PlatformAdapter')<
  PlatformAdapter,
  Service
>() {}

export {
  INITIAL_MESSAGES_WINDOW_GLOBAL,
  PlatformAdapter,
  REACT_NATIVE_WEBVIEW_GLOBAL,
}
export type { BareSender }
