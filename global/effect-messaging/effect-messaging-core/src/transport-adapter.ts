import { Context, type Effect, type Scope } from 'effect'
import type { BareSenderFunction } from './bare-sender.ts'

/** Service shape supplied at the {@link TransportAdapter} `Context.Tag`. */
interface Service {
  /** Send one already-encoded string to the other process. */
  readonly bareSender: BareSenderFunction
  /**
   * Wire the platform's live-message source into `enqueue`. Detaches on
   * scope close. Optional — an adapter may omit this and the consumer
   * feeds the transport's `enqueue` directly.
   */
  readonly attachBareSender?: (
    bareSender: BareSenderFunction
  ) => Effect.Effect<void, never, Scope.Scope>
}

/**
 * `Context.Tag` for the platform adapter. Aggregators (host wrappers,
 * tests) provide it via `Layer.succeed(TransportAdapter, …)`.
 */
class TransportAdapter extends Context.Tag('@effect-messaging/TransportAdapter')<
  TransportAdapter,
  Service
>() {}

export { TransportAdapter }
export type { Service as TransportAdapterService }
