import { Array as Arr, Effect, Option, type ParseResult, pipe } from 'effect'

import type { HttpMethod } from './http-method.ts'
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
 *
 * `method` is `Option.none()` when the source dropped the request method (a
 * HAR entry whose `request.method` is `'UNKNOWN'`). Recognition routes on
 * `(url, method)` through {@link candidatesFor} / {@link routeTo} /
 * {@link recognize}, and a matcher built via `UrlMatch.make` never claims a
 * request whose method is not one of its declared verbs.
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
 *   alongside `tryRecognize` (its `name`, its `parse`, any field a consumer
 *   adds) rides through untouched, so a consumer hands the chosen
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
  url: string,
  method: Option.Option<HttpMethod>
): readonly RecognitionCandidate<K>[] =>
  Arr.filterMap(recognizers, (kind) =>
    Option.map(kind.tryRecognize(url, method), (recognized) => ({ kind, recognized }))
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
  url: string,
  method: Option.Option<HttpMethod>
): Option.Option<RecognitionCandidate<K>> => Arr.head(candidatesFor(recognizers, url, method))

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
    candidates: candidatesFor(recognizers, response.url, response.method),
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
 * Lossless byte→string mapping for use as a `Map` key: latin1 maps one byte
 * to one code point (0x00–0xFF) with no re-encoding, so `Uint8Array` equality
 * becomes string equality and a `Map<string, …>` can dedup by body without
 * hashing. Held only for the duration of one pass over the responses; the
 * strings are discarded when the map goes out of scope.
 */
const LATIN1 = new TextDecoder('latin1')

/**
 * The dedup key one response is compared under: verb (or an explicit `absent`
 * marker for `Option.none()`), URL length, URL, and body bytes, NUL-separated
 * (written as the `\u0000` escape so the source stays text to git and grep).
 * The length prefix makes the key injective even when a URL contains a NUL:
 * the verb never contains one, and the length fixes where the URL ends, so
 * everything after it is the body. `bodyAbsent` inputs are excluded from the
 * pass entirely — an un-captured body is its own fact and two absent-body
 * entries at the same URL are not "the same response captured twice".
 */
const dedupeKeyOf = (response: Input): string => {
  const method = Option.match(response.method, {
    onNone: () => 'absent',
    onSome: (verb) => verb,
  })
  return `${method}\u0000${response.url.length}\u0000${response.url}\u0000${LATIN1.decode(response.body)}`
}

/**
 * Scan `responses` in input order and return the map of response id →
 * ResponseRef of the FIRST occurrence with the same `(url, method, body)`.
 *
 * @param responses - The responses to scan, in input order
 * @returns A map keyed by response id; an entry is present iff that response
 *   is a duplicate of an earlier one, and its value is the earlier one's
 *   `ResponseRef`. `bodyAbsent` responses are never duplicates.
 *
 * @remarks
 * The scan is O(n) in total work and O(k) in memory where k is the number
 * of distinct `(url, method, body)` seen — one entry per first occurrence,
 * plus one per detected duplicate. A routing loop checks it before routing
 * and skips {@link parseWith} for a duplicate, so the write set carries each
 * `(url, method, body)` once.
 */
const findDuplicates = (responses: readonly Input[]): ReadonlyMap<string, ResponseRef> => {
  const firstByKey = new Map<string, ResponseRef>()
  const dupByResponseId = new Map<string, ResponseRef>()
  for (const response of responses) {
    if (response.bodyAbsent) continue
    const key = dedupeKeyOf(response)
    const first = firstByKey.get(key)
    if (first === undefined) {
      firstByKey.set(key, { id: response.id, url: response.url })
    } else {
      dupByResponseId.set(response.id, first)
    }
  }
  return dupByResponseId
}

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

export { dedupeKeyOf, findDuplicates, parseWith, recognize, routeTo }
export type { Input, ParseOutcome, RecognitionCandidate, RecognizedResponse, ResponseRef }
