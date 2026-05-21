import type { Effect, Schema } from 'effect'
import type { BareSender } from './bare-sender.ts'
import type * as Message from './message.ts'

/**
 * Per-tag handler record consumed by `Bridge.make`'s `ReceiverLayer`.
 *
 * Handlers may require {@link BareSender} so they can call
 * `bridge.send(...)` to reply through the same transport that delivered
 * the inbound message — `BridgeTransport.make`'s dispatch fiber
 * discharges the requirement from its `TransportAdapter`. Handlers that
 * don't reply leave the requirement at `never`.
 */
type HandlersFor<R extends Message.SchemaRecord> = {
  readonly [Tag in keyof R]: R[Tag] extends Schema.Schema<infer A, string, never>
    ? (message: A) => Effect.Effect<void, never, BareSender>
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
