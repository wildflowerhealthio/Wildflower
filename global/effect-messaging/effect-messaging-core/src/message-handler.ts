import type { Effect, Schema } from 'effect'
import type * as Message from './message.ts'
import type { TransportAdapter } from './transport-adapter.ts'

/**
 * Per-tag handler record for one bridge half's inbound messages, passed
 * to the transport via `BridgeTransport.make`'s `handlers` tuple (or
 * swapped later through `registerHandlers`).
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

export type { HandlersFor }
