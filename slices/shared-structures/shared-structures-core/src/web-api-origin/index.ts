import { Context, Effect, Layer, Stream, Subscribable } from 'effect'

/**
 * Effect service carrying the live `Subscribable<string>` for the origin
 * the SPA's HTTP API clients should target (scheme + host + port, no
 * trailing slash). Slice clients read it *per request* via
 * {@link WebApiOrigin.get} and prepend it to the request URL, so the
 * value can change at runtime (e.g. an embedded WebView loaded from a
 * laptop dev server still routing its API calls back to the in-app
 * loopback server) without rebuilding the layer or the client.
 *
 * Mirrors `navigation-core`'s server-side `Origin` Tag: a pure
 * `Subscribable` so the React adapters can back it with `window.location`
 * (`shared-structures-react`'s location layer) or a bridge-fed
 * `SubscriptionRef` (the embedded entry's host push) without this core
 * module depending on the DOM.
 */
class WebApiOrigin extends Context.Tag('WebApiOrigin')<
  WebApiOrigin,
  Subscribable.Subscribable<string>
>() {
  /**
   * Read the current origin. Each yield re-reads via the Subscribable's
   * `get`, so a client reading this per request always sees the latest
   * host-supplied value.
   */
  static readonly get: Effect.Effect<string, never, WebApiOrigin> = Effect.flatMap(
    WebApiOrigin,
    (sub) => sub.get
  )

  /**
   * Stream of origin updates. Emits the current value and then each
   * subsequent change (e.g. the host re-pushing a rebound loopback
   * origin over the navigation bridge).
   */
  static readonly changes: Stream.Stream<string, never, WebApiOrigin> = Stream.unwrap(
    Effect.map(WebApiOrigin, (sub) => sub.changes)
  )

  /**
   * Build a constant `WebApiOrigin` Layer from a literal. Validates the
   * input ends with an alphanumeric character (no trailing slash or
   * punctuation) so the per-request `${origin}${path}` concatenation
   * stays well-formed. Handy for tests and any consumer with a fixed
   * origin; the reactive case uses the `shared-structures-react` layers.
   */
  static readonly layerFromLiteral = (origin: string): Layer.Layer<WebApiOrigin> => {
    if (!/[A-Za-z0-9]$/.test(origin)) {
      throw new Error(
        `WebApiOrigin.layerFromLiteral: origin must end with an alphanumeric character (got: ${JSON.stringify(origin)})`
      )
    }
    return Layer.succeed(
      WebApiOrigin,
      Subscribable.make({ get: Effect.succeed(origin), changes: Stream.succeed(origin) })
    )
  }
}

export { WebApiOrigin }
