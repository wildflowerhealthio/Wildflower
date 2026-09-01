import { DateTime, Effect, Option, ParseResult } from 'effect'
import { HttpResponseKind, Specificity } from 'http-extraction-fundamentals'
import { TraceExchange } from 'web-trace-core'
import { type DocumentReferenceType, toDocumentReference } from 'web-trace-core/codec'
import { toExchangeFields } from 'web-trace-core/provenance'

import type { BodyDigestUnavailable } from 'web-trace-core/capture'

import { type BodyPolicy, decideBody } from '../body-policy.ts'

/**
 * The one entity a web-trace recording needs: it claims every response and
 * records it, rather than recognizing a payload shape and decoding it.
 *
 * @packageDocumentation
 */

/**
 * Re-raise a body-digest failure as a `ParseError`, the only error type
 * `HttpResponseKind.parse` may fail with.
 *
 * @param cause - The digest failure
 * @returns The equivalent `ParseError`, naming the real reason
 *
 * @remarks
 * Scoped to the one exchange that hit it — the tracker records a failed sniff
 * and the run keeps draining — rather than swallowed, since a fabricated digest
 * would make the trace lie about a body it never hashed.
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
interface RawExchangeResponseKindOptions {
  /** Shared by every exchange in this run; half of the resource id. */
  readonly sessionId: string
  /** The capture-time body policy — bodies only, never which exchanges are recorded. */
  readonly policy: BodyPolicy
}

/**
 * Build the catch-all recording entity for one session.
 *
 * @param options - The session id every exchange carries, and the body policy
 * @returns An `HttpResponseKind` that turns any response into one trace
 *   `DocumentReference`
 *
 * @remarks
 * **`tryRecognize` is total — `Some` for every URL, minting no `source`, never
 * throwing** (it inspects nothing, so a malformed URL cannot trip it). A miss
 * here fires `CancelSnifferRequest` and aborts the user's own browsing — read
 * invariant 1 in the [package AGENTS.md](../../AGENTS.md) before touching it.
 */
const makeRawExchangeResponseKind = (
  options: RawExchangeResponseKindOptions
): HttpResponseKind.HttpResponseKind<DocumentReferenceType> =>
  HttpResponseKind.make({
    name: 'RawExchangeResponseKind',
    tryRecognize: () => Option.some({ specificity: Specificity.CATCH_ALL }),
    parse: (response) =>
      Effect.gen(function* () {
        const body = yield* Effect.mapError(
          decideBody(response, options.policy),
          digestFailureAsParseError
        )
        const settledAt = yield* DateTime.now
        return [
          yield* toDocumentReference({
            ...toExchangeFields(options.sessionId, response),
            timings: {
              wait: null,
              receive: DateTime.distanceDuration(response.startedAt, settledAt),
            },
            body,
            producedResources: [],
          }),
        ]
      }),
  })

export {
  digestFailureAsParseError,
  makeRawExchangeResponseKind,
  type RawExchangeResponseKindOptions,
}
