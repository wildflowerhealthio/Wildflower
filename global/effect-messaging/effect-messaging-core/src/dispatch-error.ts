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
 * - {@link Internal}: an invariant the dup-check + position-aligned
 *   indexing should make unreachable. Surfaces a wiring/refactor bug
 *   loudly instead of dropping the message silently.
 *
 * Re-exported as the `DispatchError` namespace from
 * `effect-messaging-core`'s barrel.
 */

/** Source channel an inbound message arrived through. */
type Source = 'live' | 'initial'

class UnknownTag extends Data.TaggedError('UnknownTag')<{
  readonly source: Source
  readonly tag: string
}> {}

/**
 * Internal-invariant failure: the tag indexed but the bridge or
 * handlers slot is missing. The dup-check + position-aligned
 * indexing inside `BridgeTransport.make` should make this
 * unreachable; surfacing it as an error keeps the wire silently
 * intact and the bug visible in logs.
 */
class Internal extends Data.TaggedError('Internal')<{
  readonly source: Source
  readonly tag: string
  readonly reason: string
}> {}

/** Union of every failure variant the inbound-dispatch fiber can yield. */
type DispatchError = ParseResult.ParseError | UnknownTag | Internal

/**
 * Map a structured {@link DispatchError} to a single
 * `Effect.logWarning` call. Transports use this in
 * `Effect.catchAll(toLog)` so every dispatch failure surfaces through
 * the same channel.
 */
const toLog = (error: DispatchError): Effect.Effect<void> => {
  if (error._tag === 'UnknownTag') {
    return Effect.logWarning(
      `[effect-messaging] unknown ${error.source} message tag: "${error.tag}"`
    )
  }
  if (error._tag === 'Internal') {
    return Effect.logWarning(
      `[effect-messaging] internal dispatch invariant violated for ${error.source} tag "${error.tag}": ${error.reason}`
    )
  }
  return Effect.logWarning(`[effect-messaging] failed to decode message: ${String(error)}`)
}

export { Internal, toLog, UnknownTag }
export type { DispatchError, Source }
