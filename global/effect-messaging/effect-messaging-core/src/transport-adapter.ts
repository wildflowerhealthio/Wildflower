import { Context, type Effect, type Scope } from 'effect'

/** Wire-format constant — the RN-WebView bridge object name on `window`. */
const REACT_NATIVE_WEBVIEW_GLOBAL = 'ReactNativeWebView' as const

/** Writes one encoded message string to the underlying transport. */
type BareSender = (encoded: string) => Effect.Effect<void>

/** Service shape supplied at the {@link TransportAdapter} `Context.Tag`. */
interface Service {
  /** Send one already-encoded string to the other process. */
  readonly bareSender: BareSender
  /**
   * Encoded message strings the platform delivered at boot — e.g. the
   * web side decodes them from `window.location.search` URL params,
   * tests inject them inline. The dispatch core enqueues each into the
   * same path live messages take.
   */
  readonly drainInitial: Effect.Effect<ReadonlyArray<string>>
  /**
   * Wire the platform's live-message source into `enqueue`. Detaches on
   * scope close. Optional — the Expo host adapter omits this and the
   * consumer wires the WebView's `onMessage` prop manually.
   */
  readonly attachLive?: (
    enqueue: (raw: string) => Effect.Effect<void>
  ) => Effect.Effect<void, never, Scope.Scope>
}

/**
 * `Context.Tag` for the platform adapter. Aggregators (web/expo wrappers,
 * tests) provide it via `Layer.succeed(TransportAdapter, …)`.
 */
class TransportAdapter extends Context.Tag('@effect-messaging/TransportAdapter')<
  TransportAdapter,
  Service
>() {}

export { TransportAdapter, REACT_NATIVE_WEBVIEW_GLOBAL }
export type { BareSender }
