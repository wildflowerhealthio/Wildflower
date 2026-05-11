import type { ParseResult } from 'effect'
import { Data, Effect } from 'effect'

/**
 * Two-bucket failure surface for inbound dispatch.
 *
 * - {@link ParseResult.ParseError}: anything Schema rejects — malformed
 *   JSON, an unrecognised `_tag`, or a known tag whose payload doesn't
 *   match. The dispatch core decodes via `Schema.parseJson(Schema.Union(...))`
 *   so the three previously-distinguished cases collapse into one
 *   parse-error variant.
 * - {@link Internal}: an invariant the dup-check + lockstep schema/handler
 *   loop should make unreachable. Surfaces a wiring/refactor bug loudly
 *   instead of dropping the message silently — e.g., a deliberate
 *   `handlers: { Tag: undefined }` cast in a test fixture.
 *
 * Re-exported as the `DispatchError` namespace from
 * `effect-messaging-core`'s barrel.
 */

/** Source channel an inbound message arrived through. */
type Source = 'live' | 'initial'

/**
 * Internal-invariant failure: the schema accepted the message but no
 * handler is wired for the tag. Reachable when a consumer passes
 * `undefined` as a handler (typically a test cast).
 */
class Internal extends Data.TaggedError('Internal')<{
  readonly source: Source
  readonly tag: string
  readonly reason: string
}> {}

/** Union of every failure variant the inbound-dispatch fiber can yield. */
type DispatchError = ParseResult.ParseError | Internal

/**
 * Map a structured {@link DispatchError} to a single
 * `Effect.logWarning` call. Transports use this in
 * `Effect.catchAll(toLog)` so every dispatch failure surfaces through
 * the same channel.
 */
const toLog = (error: DispatchError): Effect.Effect<void> => {
  if (error._tag === 'Internal') {
    return Effect.logWarning(
      `[effect-messaging] internal dispatch invariant violated for ${error.source} tag "${error.tag}": ${error.reason}`
    )
  }
  return Effect.logWarning(`[effect-messaging] failed to decode message: ${String(error)}`)
}

export { Internal, toLog }
export type { DispatchError, Source }
