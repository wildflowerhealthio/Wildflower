import type { ParseResult } from 'effect'
import { Data, Effect } from 'effect'

/**
 * Three-bucket failure surface for inbound dispatch.
 *
 * - {@link ParseResult.ParseError}: anything Schema rejects — at the
 *   envelope (`{_tag: string}`) layer or at the per-bridge specific
 *   decode. Reuses Effect's built-in error rather than wrapping; the
 *   formatter handles the rendering.
 * - {@link UnknownTag}: envelope decoded fine, but the resulting
 *   `_tag` isn't owned by any wired bridge. Distinguished from
 *   `ParseError` so callers can tell "we don't recognise this tag"
 *   from "this tag is ours but the payload is malformed".
 * - {@link DisposedReceived}: a message arrived after the transport
 *   was disposed. Rare; points at a lifecycle bug.
 *
 * Re-exported as the `DispatchError` namespace from
 * `effect-messaging-core`'s barrel.
 */

/**
 * Source channel an inbound message arrived through. Used in log
 * messages to distinguish initial-message replay from live traffic.
 */
type Source = 'live' | 'initial'

class UnknownTag extends Data.TaggedError('UnknownTag')<{
  readonly source: Source
  readonly tag: string
}> {}

class DisposedReceived extends Data.TaggedError('DisposedReceived')<{
  readonly source: Source
}> {}

/** Union of every failure variant the inbound-dispatch fiber can yield. */
type DispatchError = ParseResult.ParseError | UnknownTag | DisposedReceived

/**
 * Map a structured {@link DispatchError} to a single
 * `Effect.logWarning` call. Transports use this in
 * `Effect.catchAll(toLog)` so every dispatch failure surfaces through
 * the same channel; callers that want different behaviour (e.g. a
 * structured telemetry emit instead of a log) can substitute their
 * own catch.
 */
const toLog = (error: DispatchError): Effect.Effect<void> => {
  if (error._tag === 'UnknownTag') {
    return Effect.logWarning(
      `[effect-messaging] unknown ${error.source} message tag: "${error.tag}"`
    )
  }
  if (error._tag === 'DisposedReceived') {
    return Effect.logWarning(
      `[effect-messaging] received ${error.source} message after dispose; dropping`
    )
  }
  // ParseError: anything Schema rejected. `String(error)` gives a
  // structured tree-formatted message; sufficient for a single log
  // line.
  return Effect.logWarning(`[effect-messaging] failed to decode message: ${String(error)}`)
}

export { DisposedReceived, toLog, UnknownTag }
export type { DispatchError, Source }
