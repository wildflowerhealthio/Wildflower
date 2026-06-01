import { Effect } from 'effect'

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
