import { Effect, type Schema } from 'effect'
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

/**
 * Standard log-and-drop warning for an inbound tag that arrived while
 * no receiver was installed to handle it.
 *
 * Handler records backed by a runtime singleton — e.g. the web-side
 * collector / apps handlers that read a module-level ref and forward
 * into whatever is currently installed — call this on the empty-ref
 * branch so the message is acknowledged-and-dropped (resolved to
 * `void`) rather than throwing.
 *
 * @param receiverName - The handler record's name, used as the log
 *   prefix (e.g. `collectorWebHandlers`).
 * @param tag - The inbound message `_tag` being dropped.
 */
const droppedTagWarning = (receiverName: string, tag: string): Effect.Effect<void> =>
  Effect.logWarning(`${receiverName}: dropping ${tag} — no receiver installed`)

export { droppedTagWarning }
export type { HandlersFor }
