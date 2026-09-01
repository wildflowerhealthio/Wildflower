import { Array as Arr, Effect, Option, type ParseResult, pipe } from 'effect'

import type * as HttpResponseKind from './http-response-kind.ts'
import type { RecognizedUrlData } from './http-response-kind.ts'
import * as HttpResponse from './http-response.ts'

/**
 * One archived response to extract from, as a plain struct — everything an
 * {@link HttpResponse.HttpResponse} exposes, with the body
 * already in hand.
 *
 * @remarks
 * An archive reader's parsed entry lines up with this *by shape only*: this
 * package names no archive format and depends on nothing that does, so a HAR
 * entry, a fixture, a proxy log, or a future capture format feeds
 * {@link recognize} and {@link parseWith} just as well.
 *
 * `bodyAbsent` is the source's "the body was not captured" flag — distinct
 * from a genuinely empty body (`body: new Uint8Array()`, `bodyAbsent: false`).
 * An archive can record an exchange while omitting its content, and decoding
 * that as an empty payload would manufacture a parse failure for a response
 * that was never in evidence — so {@link parseWith} folds it to its own
 * outcome instead.
 */
interface Input extends HttpResponse.Data {
  readonly bodyAbsent: boolean
}

/** The `(id, url)` pair every extraction outcome is keyed by. */
interface ResponseRef {
  readonly id: string
  readonly url: string
}

/**
 * One kind that claimed a URL, paired with the recognition it claimed with —
 * the element of {@link routeTo}'s answer and of {@link recognize}'s ranked
 * candidate lists.
 *
 * @typeParam K - The caller's concrete kind type; whatever it carries
 *   alongside `tryRecognize` (its `name`, its `parse`, the collector's
 *   `followUpSteps`) rides through untouched, so a consumer hands the chosen
 *   `kind` straight to {@link parseWith} — no by-name lookup against the pool
 */
interface RecognitionCandidate<K> {
  readonly kind: K
  readonly recognized: RecognizedUrlData
}

/** The one field routing reads off a kind. */
type Recognizes = Pick<HttpResponseKind.HttpResponseKind<never>, 'tryRecognize'>

/**
 * Every kind that claims `url`, most specific first — the single place the
 * ranking rule lives. {@link routeTo} is its head; {@link recognize} maps it
 * over a response set.
 *
 * @remarks
 * The sort is stable (spec-guaranteed), so equal specificities keep pool
 * order. That makes a tie deterministic, but a tie means the ranking is
 * under-specified — the fix is to separate the `specificity` values, not to
 * rely on pool order. Every candidate's `tryRecognize` runs (they are pure and
 * few), so short-circuiting would buy nothing.
 */
const candidatesFor = <K extends Recognizes>(
  recognizers: readonly K[],
  url: string
): readonly RecognitionCandidate<K>[] =>
  Arr.filterMap(recognizers, (kind) =>
    Option.map(kind.tryRecognize(url), (recognized) => ({ kind, recognized }))
  ).toSorted((a, b) => b.recognized.specificity - a.recognized.specificity)

/**
 * Pick the one response kind that claims `url` — the head of
 * {@link candidatesFor}, whose remarks state the tie-break rule.
 *
 * @typeParam K - The caller's concrete kind type — see
 *   {@link RecognitionCandidate}
 * @param recognizers - The candidate kinds, in list order
 * @param url - The response URL to route
 * @returns The claiming kind of maximal `specificity` paired with its
 *   {@link RecognizedUrlData}, or `None` when none claims
 */
const routeTo = <K extends Recognizes>(
  recognizers: readonly K[],
  url: string
): Option.Option<RecognitionCandidate<K>> => Arr.head(candidatesFor(recognizers, url))

/** Every kind that claimed one response, sorted most-specific first. */
interface RecognizedResponse<K> {
  readonly ref: ResponseRef
  readonly candidates: readonly RecognitionCandidate<K>[]
}

/**
 * Recognize each response against the whole pool, keeping **every** kind that
 * claimed it — the ranked candidate set an interactive per-response picker
 * needs, where {@link routeTo} resolves the single winner.
 *
 * @typeParam K - The caller's concrete kind type — see
 *   {@link RecognitionCandidate}
 * @param recognizers - The candidate kinds, in list order
 * @param responses - The responses to recognize, in input order
 * @returns One {@link RecognizedResponse} per input response, its `candidates`
 *   most specific first, `[]` when no kind claimed
 */
const recognize = <K extends Recognizes>(
  recognizers: readonly K[],
  responses: readonly Input[]
): readonly RecognizedResponse<K>[] =>
  responses.map((response) => ({
    ref: { id: response.id, url: response.url },
    candidates: candidatesFor(recognizers, response.url),
  }))

/**
 * What decoding one response through a chosen kind produced — never failing:
 * every outcome, including a decode error and an absent body, is data.
 */
type ParseOutcome<TParsed> =
  | { readonly _tag: 'resources'; readonly resources: readonly TParsed[] }
  | { readonly _tag: 'parseError'; readonly error: ParseResult.ParseError }
  | { readonly _tag: 'bodyAbsent' }

/**
 * Decode one response through `kind`, folding every outcome into data.
 *
 * @typeParam TParsed - The resource type `kind` decodes to
 * @param kind - The chosen response kind (only its `parse` is read)
 * @param response - The response to decode
 * @returns A never-failing Effect of the {@link ParseOutcome}: `bodyAbsent`
 *   (checked before `parse` runs, so `parse` never sees an un-captured body),
 *   `parseError`, or `resources`
 */
const parseWith = <TParsed>(
  kind: Pick<HttpResponseKind.HttpResponseKind<TParsed>, 'parse'>,
  response: Input
): Effect.Effect<ParseOutcome<TParsed>> =>
  response.bodyAbsent
    ? Effect.succeed({ _tag: 'bodyAbsent' })
    : pipe(
        kind.parse(HttpResponse.make(response)),
        Effect.match({
          onFailure: (error): ParseOutcome<TParsed> => ({ _tag: 'parseError', error }),
          onSuccess: (resources): ParseOutcome<TParsed> => ({ _tag: 'resources', resources }),
        })
      )

export { parseWith, recognize, routeTo }
export type { Input, ParseOutcome, RecognitionCandidate, RecognizedResponse, ResponseRef }
