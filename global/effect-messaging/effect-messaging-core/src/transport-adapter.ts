import { Context, type Effect, type Scope } from 'effect'

/** Wire-format constant — the page-side global the host pre-populates. */
const INITIAL_MESSAGES_WINDOW_GLOBAL = '__INITIAL_MESSAGES__' as const

/** Wire-format constant — the RN-WebView bridge object name on `window`. */
const REACT_NATIVE_WEBVIEW_GLOBAL = 'ReactNativeWebView' as const

/** Writes one encoded message string to the underlying transport. */
type BareSender = (encoded: string) => Effect.Effect<void>

/** Service shape supplied at the {@link TransportAdapter} `Context.Tag`. */
interface Service {
  /** Send one already-encoded string to the other process. */
  readonly bareSender: BareSender
  /** Pre-existing initial-message strings the host injected before the bundle ran. */
  readonly drainInitial: Effect.Effect<ReadonlyArray<string>>
  /**
   * Wire the platform's live-message source into `enqueue`. Detaches on
   * scope close. Optional — the Expo host adapter omits this and the
   * consumer wires the WebView's `onMessage` prop manually.
   */
  readonly attachLive?: (enqueue: (raw: string) => void) => Effect.Effect<void, never, Scope.Scope>
}

/**
 * `Context.Tag` for the platform adapter. Aggregators (web/expo wrappers,
 * tests) provide it via `Layer.succeed(TransportAdapter, …)`.
 */
class TransportAdapter extends Context.Tag('@effect-messaging/TransportAdapter')<
  TransportAdapter,
  Service
>() {}

export { INITIAL_MESSAGES_WINDOW_GLOBAL, TransportAdapter, REACT_NATIVE_WEBVIEW_GLOBAL }
export type { BareSender }
