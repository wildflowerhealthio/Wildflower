import { Effect, Layer, Stream, Subscribable, SubscriptionRef } from 'effect'
import { WebApiOrigin } from 'shared-structures-core/web-api-origin'

/**
 * `WebApiOrigin` Layer for environments where the page is served from
 * the same origin its API calls should target — standalone web and the
 * default embedded build (loopback page + loopback API on one origin).
 *
 * Reads `window.location.origin` per `get`, so the value tracks the live
 * page origin without baking it in at layer-build time. `changes` emits
 * once (a page's own origin is stable for its lifetime).
 *
 * The reactive, host-driven case — an embedded WebView whose page is
 * served from a remote dev server but whose API calls must still reach
 * the in-app loopback server — uses {@link makeWebApiOriginBridgeStore}
 * instead.
 */
const webApiOriginLocationLayer: Layer.Layer<WebApiOrigin> = Layer.sync(WebApiOrigin, () =>
  Subscribable.make({
    get: Effect.sync(() => window.location.origin),
    changes: Stream.fromEffect(Effect.sync(() => window.location.origin)),
  })
)

/**
 * The mutable {@link WebApiOrigin} seam an embedded entry threads from
 * the host bridge: a `SubscriptionRef`-backed Layer plus the `set`
 * write side the navigation handler calls when the host pushes a
 * `HostApiOriginChanged`.
 *
 * Mirrors the auth-token store's two-halves split (`react-kitchen-sink`):
 * the read side is a `Subscribable` (here pre-wrapped as a Layer the
 * runtime merges), the write side is one synchronous `set`. Reading
 * per request, slice clients see a re-pointed origin on the next call
 * without rebuilding the runtime or the client.
 */
interface WebApiOriginBridgeStore {
  /** Constant `WebApiOrigin` Layer backed by the live `SubscriptionRef`. */
  readonly layer: Layer.Layer<WebApiOrigin>
  /**
   * Replace the current origin. Synchronous — `WebApiOrigin.changes`
   * emits the new value before this returns.
   */
  readonly set: (origin: string) => void
}

/**
 * Build a {@link WebApiOriginBridgeStore} seeded with `initialOrigin`
 * (typically the loopback API origin the host knows at boot). The host
 * later calls `set` with the rebound origin if it changes.
 */
const makeWebApiOriginBridgeStore = (initialOrigin: string): WebApiOriginBridgeStore => {
  const ref = Effect.runSync(SubscriptionRef.make(initialOrigin))
  return {
    layer: Layer.succeed(WebApiOrigin, ref),
    set: (origin) => Effect.runSync(SubscriptionRef.set(ref, origin)),
  }
}

export { makeWebApiOriginBridgeStore, webApiOriginLocationLayer }
export type { WebApiOriginBridgeStore }
