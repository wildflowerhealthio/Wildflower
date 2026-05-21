import { Context, Effect, Layer, Stream, Subscribable } from 'effect'

/**
 * Effect service carrying the live `Subscribable<string>` for the
 * current public origin (the URL at which clients should reach this
 * server). Consumers typically read via the `Origin.get` Effect — which
 * `.get`s the Subscribable — so a tunnel toggle surfaces on the next
 * read without rebuilding the layer or runtime.
 *
 * The package that owns the live origin (e.g. `tunnel-core`) constructs
 * the Subscribable from `servedOrigin$` and wires it via a Layer that
 * depends on `TunnelStore | LocalHttpServerStore`. Consumers of `Origin`
 * stay slice-agnostic — they only see the `Origin` requirement.
 */
class Origin extends Context.Tag('Origin')<Origin, Subscribable.Subscribable<string>>() {
  /**
   * Read the current origin value. Each yield re-reads via the
   * Subscribable's `get`, so callers always see the latest value.
   */
  static readonly get: Effect.Effect<string, never, Origin> = Effect.flatMap(
    Origin,
    (sub) => sub.get
  )

  /**
   * Stream of origin updates. Emits the current value and then each
   * subsequent change (e.g. tunnel toggles, LHS rebind). Sources its
   * subscription from the Layer-provided Subscribable.
   */
  static readonly changes: Stream.Stream<string, never, Origin> = Stream.unwrap(
    Effect.map(Origin, (sub) => sub.changes)
  )

  /**
   * Build a constant `Origin` Layer from a string literal — for tests
   * and other static-origin contexts. The `changes` stream emits the
   * value once and then completes, so consumers that observe changes
   * don't dead-lock waiting for an emit that will never come.
   */
  static readonly layerFromLiteral = (origin: string): Layer.Layer<Origin> =>
    Layer.succeed(
      Origin,
      Subscribable.make({ get: Effect.succeed(origin), changes: Stream.succeed(origin) })
    )
}

export { Origin }
