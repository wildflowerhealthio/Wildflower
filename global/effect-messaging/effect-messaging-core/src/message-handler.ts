import { Effect, type Schema } from 'effect'
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
 */
type HandlersFor<R extends Message.SchemaRecord> = {
  readonly [Tag in keyof R]: R[Tag] extends Schema.Schema<infer A, string, never>
    ? (message: A) => Effect.Effect<void>
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
