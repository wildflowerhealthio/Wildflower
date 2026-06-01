import type { Effect, Schema } from 'effect'
import type * as Message from './message.ts'

/**
 * Per-tag handler record for one bridge side's inbound messages, passed
 * to the transport via `BridgeTransport.make`'s `handlers` tuple (or
 * swapped later through `registerHandlers`).
 *
 * @remarks
 * Each handler returns a pure `Effect<void>` — it acknowledges the
 * inbound message and has no requirements. Handlers never reply through
 * the bridge directly; a host slice that needs to send proactively
 * captures its transport sender via `HostBindings`' `onTransportReady`
 * and dispatches through that captured ref.
 *
 * This is the fully-typed end of the handler spectrum; {@link Handler}
 * is its routing-erased counterpart, reached once the dispatch fiber has
 * narrowed a decoded message to its `_tag`.
 */
type HandlersFor<R extends Message.SchemaRecord> = {
  readonly [Tag in keyof R]: R[Tag] extends Schema.Schema<infer A, string, never>
    ? (message: A) => Effect.Effect<void>
    : never
}

/**
 * Decoded inbound message at the routing site. Schema acceptance
 * guarantees a `_tag`; the dispatch fiber re-narrows to it for the
 * handler lookup. The floor shape {@link Handler} accepts.
 */
type DecodedMessage = { readonly _tag: string }

/**
 * Routing-erased handler: the shape a {@link HandlersFor} member
 * collapses to once the transport's dispatch fiber has decoded a wire
 * string and re-narrowed it to its `_tag`. A pure
 * `(message) => Effect<void>` with no requirements — handlers
 * acknowledge-and-return and never reply through the transport.
 */
type Handler = (message: DecodedMessage) => Effect.Effect<void>

/**
 * Flat tag→handler lookup the transport's dispatch fiber holds (in a
 * `Ref`) and reads on every inbound message. A tag absent from the
 * record has no installed handler — its messages are logged-and-dropped.
 */
type AnyHandlers = Readonly<Record<string, Handler | undefined>>

export type { AnyHandlers, DecodedMessage, Handler, HandlersFor }
