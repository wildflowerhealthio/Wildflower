import { Effect } from 'effect'

/**
 * Standard log-and-drop warning for an inbound tag that arrived while
 * no receiver was installed to handle it.
 *
 * Dispatchers backed by a runtime registry — e.g. `PageDispatcher`,
 * which looks up the per-bridge record currently registered and
 * forwards into it — call this on the empty branch so the message is acknowledged-and-dropped (resolved to
 * `void`) rather than throwing.
 *
 * @param receiverName - The handler record's name, used as the log
 *   prefix (e.g. the bridge name, `Recorder`).
 * @param tag - The inbound message `_tag` being dropped.
 */
const warnAboutDroppedTag = (receiverName: string, tag: string): Effect.Effect<void> =>
  Effect.logWarning(`${receiverName}: dropping ${tag} — no receiver installed`)

export { warnAboutDroppedTag }
