import { EntityDefinition } from 'collector-fundamentals/model'
import { DateTime, Effect, ParseResult } from 'effect'
import { TraceExchange } from 'web-trace-core'
import { type DocumentReferenceType, toDocumentReference } from 'web-trace-core/codec'

import { type BodyDigestUnavailable, type BodyPolicy, decideBody } from '../body-policy.ts'

/**
 * The one entity a web-trace recording needs: it claims every response and
 * records it, rather than recognizing a payload shape and decoding it.
 *
 * @packageDocumentation
 */

/**
 * Re-raise a body-digest failure as a `ParseError`, the only error type
 * `EntityDefinition.parse` may fail with.
 *
 * @param cause - The digest failure
 * @returns The equivalent `ParseError`, naming the real reason
 *
 * @remarks
 * `Forbidden` is the issue for an effectful step that refused, which is exactly
 * what happened. The failure is scoped to the one exchange that hit it: the
 * tracker records a failed sniff and the run keeps draining, so a session is
 * never lost to it (nor is the failure swallowed — a fabricated digest would
 * make the trace lie about a body it never hashed).
 */
const digestFailureAsParseError = (cause: BodyDigestUnavailable): ParseResult.ParseError =>
  new ParseResult.ParseError({
    issue: new ParseResult.Forbidden(
      TraceExchange.ast,
      cause,
      `Could not hash the response body: ${cause.reason}`
    ),
  })

/** What a recording run pins for the lifetime of one session. */
interface RawExchangeEntityOptions {
  /** Shared by every exchange in this run; half of the resource id. */
  readonly sessionId: string
  /** The capture-time body policy — bodies only, never which exchanges are recorded. */
  readonly policy: BodyPolicy
}

/**
 * Build the catch-all recording entity for one session.
 *
 * @param options - The session id every exchange carries, and the body policy
 * @returns An `EntityDefinition` that turns any response into one trace
 *   `DocumentReference`
 *
 * @remarks
 * **`isFoundAt` returns `true` unconditionally, and that matters twice.** The
 * obvious half is coverage: a recording that filtered by URL would decide in
 * advance what a collector author is allowed to discover, which is the opposite
 * of the point. The half that is easy to miss is that
 * `CollectorBridgeMessageHandler` fires a `CancelSnifferRequest` at any response
 * no entity claims — so a narrower predicate here would not merely skip those
 * exchanges, it would **abort the requests the user's own browsing depends on**
 * and break the page in front of them.
 *
 * The encoding is `web-trace-core`'s and is imported, never re-derived: a second
 * copy would drift and already-recorded sessions would stop decoding.
 */
const makeRawExchangeEntity = (
  options: RawExchangeEntityOptions
): EntityDefinition.EntityDefinition<DocumentReferenceType> =>
  EntityDefinition.make({
    name: 'RawExchangeEntity',
    // Catch-all — see the remarks above before narrowing this.
    isFoundAt: () => true,
    parse: (response) =>
      Effect.gen(function* () {
        const body = yield* Effect.mapError(
          decideBody(response, options.policy),
          digestFailureAsParseError
        )
        const settledAt = yield* DateTime.now
        return [
          yield* toDocumentReference({
            sessionId: options.sessionId,
            requestId: response.id,
            url: response.url,
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            startedAt: response.startedAt,
            timings: {
              // Nothing observes the request side, so there is no wait to
              // report and none is invented.
              wait: null,
              // Response start → body complete. Read here rather than threaded
              // through the tracker, so it includes the handler's dispatch of
              // this parse; that is a sub-millisecond overstatement on a real
              // capture, and it is a measurement rather than a guess.
              receive: DateTime.distanceDuration(response.startedAt, settledAt),
            },
            body,
          }),
        ]
      }),
    // No `followUpSteps`: a recording follows the user, never the other way
    // round. Generating navigation here would put pages in the trace that the
    // user never visited, and move the browser under them while they browse.
  })

export { digestFailureAsParseError, makeRawExchangeEntity, type RawExchangeEntityOptions }
