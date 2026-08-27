import { Array as Arr, Effect, Match, Option, type ParseResult, pipe } from 'effect'

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
 * entry, a fixture, a proxy log, or a future capture format feeds {@link run}
 * just as well.
 *
 * `bodyAbsent` is the source's "the body was not captured" flag — distinct
 * from a genuinely empty body (`body: new Uint8Array()`, `bodyAbsent: false`).
 * An archive can record an exchange while omitting its content, and decoding
 * that as an empty payload would manufacture a parse failure for a response
 * that was never in evidence — so {@link run} reports it as its own outcome
 * instead.
 */
interface Input extends HttpResponse.Init {
  readonly bodyAbsent: boolean
}

/** The `(id, url)` pair every extraction outcome is keyed by. */
interface ResponseRef {
  readonly id: string
  readonly url: string
}

/**
 * What one matched, parsed response produced.
 *
 * @remarks
 * Per-response rather than one flat resource array: an import preview shows
 * which response yielded what, and flattening is a `flatMap` away for a
 * caller that doesn't care.
 */
interface Batch<TResources> extends ResponseRef {
  readonly entityName: string
  readonly resources: readonly TResources[]
}

/** A matched response whose `parse` failed. Data, not a fold-aborting error. */
interface ParseFailure extends ResponseRef {
  readonly entityName: string
  readonly error: ParseResult.ParseError
}

/**
 * A matched response the archive carried no body for — see
 * {@link Input.bodyAbsent}. `parse` was never called.
 */
interface BodyAbsent extends ResponseRef {
  readonly entityName: string
}

/**
 * The complete accounting of one extraction: every input response lands in
 * exactly one of the four arrays, each in input order.
 *
 * @remarks
 * Nothing here is an error channel. A response no entity claimed
 * (`unmatched`), one whose decode failed (`parseFailures`), and one the
 * archive recorded without a body (`bodyAbsent`) are all ordinary outcomes of
 * extracting from traffic that was never captured for this purpose — a caller
 * reports them, it does not recover from them.
 */
interface Extraction<TResources> {
  readonly batches: readonly Batch<TResources>[]
  readonly unmatched: readonly ResponseRef[]
  readonly parseFailures: readonly ParseFailure[]
  readonly bodyAbsent: readonly BodyAbsent[]
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
type Recognizes = Pick<HttpResponseKind.HttpResponseKind<unknown>, 'tryRecognize'>

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
  pool: readonly K[],
  url: string
): readonly RecognitionCandidate<K>[] =>
  Arr.filterMap(pool, (kind) =>
    Option.map(kind.tryRecognize(url), (recognized) => ({ kind, recognized }))
  ).toSorted((a, b) => b.recognized.specificity - a.recognized.specificity)

/**
 * Pick the one response kind that claims `url`, highest specificity wins
 * (ties → pool order).
 *
 * @typeParam K - The caller's concrete kind type — see
 *   {@link RecognitionCandidate}
 * @param pool - The candidate kinds, in list order
 * @param url - The response URL to route
 * @returns The claiming kind of maximal `specificity` paired with its
 *   {@link RecognizedUrlData}, or `None` when none claims
 *
 * @remarks
 * Generic in the concrete element (constraint = just the `tryRecognize` field,
 * a `Pick` so the constraint reads only what routing needs) so a caller's
 * extra fields ride through untouched. The head of {@link candidatesFor},
 * whose remarks state the tie-break rule.
 */
const routeTo = <K extends Recognizes>(
  pool: readonly K[],
  url: string
): Option.Option<RecognitionCandidate<K>> => Arr.head(candidatesFor(pool, url))

/** Every kind that claimed one response, sorted most-specific first. */
interface RecognizedResponse<K> {
  readonly ref: ResponseRef
  readonly candidates: readonly RecognitionCandidate<K>[]
}

/**
 * Recognize each response against the whole pool, keeping **every** kind that
 * claimed it.
 *
 * @typeParam K - The caller's concrete kind type — see
 *   {@link RecognitionCandidate}
 * @param pool - The candidate kinds, in list order
 * @param responses - The responses to recognize, in input order
 * @returns One {@link RecognizedResponse} per input response, its `candidates`
 *   sorted by specificity descending (ties → list order), `[]` when no kind
 *   claimed
 *
 * @remarks
 * Unlike {@link routeTo} (which resolves the single winner), this keeps the
 * whole ranked candidate set — the input an interactive per-response picker
 * needs when a real cross-source overlap gives a reviewer a choice.
 */
const recognize = <K extends Recognizes>(
  pool: readonly K[],
  responses: readonly Input[]
): readonly RecognizedResponse<K>[] =>
  responses.map((response) => ({
    ref: { id: response.id, url: response.url },
    candidates: candidatesFor(pool, response.url),
  }))

/**
 * What decoding one response through a chosen kind produced — never failing:
 * every outcome, including a decode error and an absent body, is data.
 */
type ParseOutcome<TResources> =
  | { readonly _tag: 'resources'; readonly resources: readonly TResources[] }
  | { readonly _tag: 'parseError'; readonly error: ParseResult.ParseError }
  | { readonly _tag: 'bodyAbsent' }

/**
 * Decode one response through `kind`, folding every outcome into data.
 *
 * @typeParam TResources - The resource type `kind` decodes to
 * @param kind - The chosen response kind (only its `parse` is read)
 * @param response - The response to decode
 * @returns A never-failing Effect of the {@link ParseOutcome}: `bodyAbsent`
 *   (checked before `parse` runs, so `parse` never sees an un-captured body),
 *   `parseError`, or `resources`
 */
const parseWith = <TResources>(
  kind: Pick<HttpResponseKind.HttpResponseKind<TResources>, 'parse'>,
  response: Input
): Effect.Effect<ParseOutcome<TResources>> =>
  response.bodyAbsent
    ? Effect.succeed({ _tag: 'bodyAbsent' })
    : pipe(
        kind.parse(HttpResponse.make(response)),
        Effect.match({
          onFailure: (error): ParseOutcome<TResources> => ({ _tag: 'parseError', error }),
          onSuccess: (resources): ParseOutcome<TResources> => ({ _tag: 'resources', resources }),
        })
      )

/**
 * One response's landing spot in the four-way {@link Extraction} accounting,
 * tagged so {@link run} can group what {@link outcomeOf} mapped.
 */
type RunOutcome<TResources> =
  | { readonly _tag: 'batch'; readonly value: Batch<TResources> }
  | { readonly _tag: 'unmatched'; readonly value: ResponseRef }
  | { readonly _tag: 'parseFailure'; readonly value: ParseFailure }
  | { readonly _tag: 'bodyAbsent'; readonly value: BodyAbsent }

/** Route one response and decode it if claimed — the map {@link run} folds. */
const outcomeOf = <TResources>(
  responseKinds: readonly HttpResponseKind.HttpResponseKind<TResources>[],
  response: Input
): Effect.Effect<RunOutcome<TResources>> => {
  const ref: ResponseRef = { id: response.id, url: response.url }
  return pipe(
    routeTo(responseKinds, response.url),
    Option.match({
      onNone: () => Effect.succeed<RunOutcome<TResources>>({ _tag: 'unmatched', value: ref }),
      onSome: ({ kind }) =>
        Effect.map(parseWith(kind, response), (outcome): RunOutcome<TResources> =>
          Match.value(outcome).pipe(
            Match.tag('bodyAbsent', () => ({
              _tag: 'bodyAbsent' as const,
              value: { ...ref, entityName: kind.name },
            })),
            Match.tag('parseError', ({ error }) => ({
              _tag: 'parseFailure' as const,
              value: { ...ref, entityName: kind.name, error },
            })),
            Match.tag('resources', ({ resources }) => ({
              _tag: 'batch' as const,
              value: { ...ref, entityName: kind.name, resources },
            })),
            Match.exhaustive
          )
        ),
    })
  )
}

/**
 * Run a static set of archived responses through a source's entities.
 *
 * @typeParam TResources - The resource type the entities decode to
 * @param responseKinds - The source's entities, in list order; the kind whose
 *   `tryRecognize` claims a response's URL with the **highest specificity**
 *   claims it (ties → list order)
 * @param responses - The responses to extract from, in the order they should
 *   be seen
 * @returns The four-way {@link Extraction} accounting — batches, unmatched,
 *   parse failures, absent bodies — each in input order
 *
 * @remarks
 * A deterministic map-then-group rebuilt on {@link routeTo} +
 * {@link parseWith}, so the live tracker and this archive runner route through
 * the one function — same highest-specificity-wins routing (a change from the
 * old first-match-wins: overlapping same-specificity patterns still resolve by
 * list order, so keep intra-source patterns disjoint), same
 * {@link HttpResponse.HttpResponse} handed to `parse`, same "one bad response
 * never takes the run down" isolation. `collector-fundamentals`'
 * `extraction-parity.test.ts` pins that its live sniffer path routes and
 * decodes identically.
 *
 * **The runner does not persist.** It hands back what it decoded; writing is
 * the caller's separate, opt-in step. That is what makes a
 * preview-then-confirm flow possible, and it keeps the runner a pure function
 * of its inputs.
 *
 * The `Effect` is infallible (`never` in the error channel): every failure
 * mode is reported as data, and the effect is only there because `parse` is
 * effectful.
 */
const run = <TResources>(
  responseKinds: readonly HttpResponseKind.HttpResponseKind<TResources>[],
  responses: readonly Input[]
): Effect.Effect<Extraction<TResources>> =>
  pipe(
    // Sequential (Effect.forEach's default), so outcomes — and therefore each
    // of the four groups below — keep input order.
    Effect.forEach(responses, (response) => outcomeOf(responseKinds, response)),
    // `Array.groupBy` is string-keyed (`Record<string, …>`) and would lose the
    // union's narrowing, so the group-by is one typed filterMap per arm.
    Effect.map((outcomes) => ({
      batches: Arr.filterMap(outcomes, (outcome) =>
        outcome._tag === 'batch' ? Option.some(outcome.value) : Option.none()
      ),
      unmatched: Arr.filterMap(outcomes, (outcome) =>
        outcome._tag === 'unmatched' ? Option.some(outcome.value) : Option.none()
      ),
      parseFailures: Arr.filterMap(outcomes, (outcome) =>
        outcome._tag === 'parseFailure' ? Option.some(outcome.value) : Option.none()
      ),
      bodyAbsent: Arr.filterMap(outcomes, (outcome) =>
        outcome._tag === 'bodyAbsent' ? Option.some(outcome.value) : Option.none()
      ),
    }))
  )

export { parseWith, recognize, routeTo, run }
export type {
  Batch,
  BodyAbsent,
  Extraction,
  Input,
  ParseFailure,
  ParseOutcome,
  RecognitionCandidate,
  RecognizedResponse,
  ResponseRef,
}
