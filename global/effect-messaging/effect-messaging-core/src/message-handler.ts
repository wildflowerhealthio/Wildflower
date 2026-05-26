import type { Effect, Schema } from 'effect'
import type * as Message from './message.ts'
import type { TransportAdapter } from './transport-adapter.ts'

/**
 * Per-tag handler record consumed by `Bridge.make`'s `ReceiverLayer`.
 *
 * @remarks
 * Each handler returns `Effect<void, never, TransportAdapter>` so a
 * handler can dispatch a reply via the same-bridge `send(...)` (which
 * requires `TransportAdapter`). The dispatch fiber satisfies the
 * requirement per-invocation by running each handler under the
 * transport's own adapter — see `bridge-transport.ts`.
 *
 * Handlers that don't need a reply still typecheck: an
 * `Effect<void, never, never>` is assignable to
 * `Effect<void, never, TransportAdapter>` (`R` is covariant in
 * `Effect`).
 */
type HandlersFor<R extends Message.SchemaRecord> = {
  readonly [Tag in keyof R]: R[Tag] extends Schema.Schema<infer A, string, never>
    ? (message: A) => Effect.Effect<void, never, TransportAdapter>
    : never
}

/**
 * String-literal identifier for a bridge half's `Context.Tag`.
 *
 * @remarks
 * Two `Bridge.make({name: 'X', …})` calls produce type-equivalent
 * `HandlerTag`s but runtime-distinct tag instances; the runtime never
 * confuses two bridges, but TS can't catch accidental name collisions.
 */
type TagId<Name extends string, Side extends 'Host' | 'Web'> = `${Name}.${Side}.HandlerTag`

export type { HandlersFor, TagId }
