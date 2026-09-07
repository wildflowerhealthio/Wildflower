import { Effect, Match, Option, type ParseResult, pipe } from 'effect'

import * as Extraction from './extraction.ts'
import type * as HttpResponseKind from './http-response-kind.ts'

/**
 * The archive-runner **reference model**: fold a static response set through
 * `Extraction.routeTo` + `parseWith` into a four-way accounting. The
 * interactive review replaced it as the production import path (an untouched
 * review writes exactly what this runner would), so it lives with the test
 * helpers as the executable spec the suites pin against: the live/offline
 * parity test routes the tracker's output against it, and a format binding
 * asserts its fixture decodes through it.
 *
 * @packageDocumentation
 */

/**
 * What one matched, parsed response produced.
 *
 * @remarks
 * Per-response rather than one flat resource array, so an assertion can say
 * which response yielded what; flattening is a `flatMap` away.
 */
interface Batch<TParsed> extends Extraction.ResponseRef {
  readonly responseKindName: string
  readonly resources: readonly TParsed[]
}

/** A matched response whose `parse` failed. Data, not a fold-aborting error. */
interface ParseFailure extends Extraction.ResponseRef {
  readonly responseKindName: string
  readonly error: ParseResult.ParseError
}

/**
 * A matched response the archive carried no body for — see
 * {@link Extraction.Input.bodyAbsent}. `parse` was never called.
 */
interface BodyAbsent extends Extraction.ResponseRef {
  readonly responseKindName: string
}

/**
 * A response whose `(url, method, body)` matched an earlier response in the
 * same pass. `parse` was never called — the write set already carries the
 * first occurrence's resources, so re-parsing the duplicate would double
 * every write.
 *
 * @remarks
 * `of` is the earlier response's `ResponseRef`. A duplicate carries no
 * `responseKindName`: it never routed to a kind, since dedup runs before
 * recognition.
 */
interface Duplicate extends Extraction.ResponseRef {
  readonly of: Extraction.ResponseRef
}

/**
 * The complete accounting of one extraction: every input response lands in
 * exactly one of the five arrays, each in input order.
 *
 * @remarks
 * Nothing here is an error channel. A response no kind claimed (`unmatched`),
 * one whose decode failed (`parseFailures`), one the archive recorded without
 * a body (`bodyAbsent`), and one that repeated an earlier `(url, method,
 * body)` (`duplicates`) are all ordinary outcomes of extracting from traffic
 * that was never captured for this purpose.
 */
interface ExtractionResult<TParsed> {
  readonly batches: readonly Batch<TParsed>[]
  readonly unmatched: readonly Extraction.ResponseRef[]
  readonly parseFailures: readonly ParseFailure[]
  readonly bodyAbsent: readonly BodyAbsent[]
  readonly duplicates: readonly Duplicate[]
}

/**
 * One response's landing spot in the five-way {@link ExtractionResult}
 * accounting, tagged so {@link runExtraction} can group what {@link outcomeOf}
 * mapped.
 */
type RunOutcome<TParsed> =
  | { readonly _tag: 'batch'; readonly value: Batch<TParsed> }
  | { readonly _tag: 'unmatched'; readonly value: Extraction.ResponseRef }
  | { readonly _tag: 'parseFailure'; readonly value: ParseFailure }
  | { readonly _tag: 'bodyAbsent'; readonly value: BodyAbsent }
  | { readonly _tag: 'duplicate'; readonly value: Duplicate }

/** Route one response and decode it if claimed — the map {@link runExtraction} folds. */
const outcomeOf = <TParsed>(
  responseKinds: readonly HttpResponseKind.HttpResponseKind<TParsed>[],
  duplicates: ReadonlyMap<string, Extraction.ResponseRef>,
  response: Extraction.Input
): Effect.Effect<RunOutcome<TParsed>> => {
  const ref: Extraction.ResponseRef = { id: response.id, url: response.url }
  const duplicateOf = duplicates.get(response.id)
  if (duplicateOf !== undefined) {
    return Effect.succeed<RunOutcome<TParsed>>({
      _tag: 'duplicate',
      value: { ...ref, of: duplicateOf },
    })
  }
  return pipe(
    Extraction.routeTo(responseKinds, response.url, response.method),
    Option.match({
      onNone: () => Effect.succeed<RunOutcome<TParsed>>({ _tag: 'unmatched', value: ref }),
      onSome: ({ kind }) =>
        Effect.map(Extraction.parseWith(kind, response), (outcome): RunOutcome<TParsed> =>
          Match.value(outcome).pipe(
            Match.tag('bodyAbsent', () => ({
              _tag: 'bodyAbsent' as const,
              value: { ...ref, responseKindName: kind.name },
            })),
            Match.tag('parseError', ({ error }) => ({
              _tag: 'parseFailure' as const,
              value: { ...ref, responseKindName: kind.name, error },
            })),
            Match.tag('resources', ({ resources }) => ({
              _tag: 'batch' as const,
              value: { ...ref, responseKindName: kind.name, resources },
            })),
            // Dedup runs before routing, so a routed response never carries
            // this outcome — see the early return above.
            Match.tag('duplicate', ({ of }) => ({
              _tag: 'duplicate' as const,
              value: { ...ref, of },
            })),
            Match.exhaustive
          )
        ),
    })
  )
}

/**
 * Run a static set of archived responses through a source's response kinds.
 *
 * @typeParam TParsed - The resource type the kinds decode to
 * @param responseKinds - The candidate kinds, in list order; each response is
 *   claimed per `Extraction.routeTo`'s ranking
 * @param responses - The responses to extract from, in the order they should
 *   be seen
 * @returns The four-way {@link ExtractionResult} accounting — batches,
 *   unmatched, parse failures, absent bodies — each in input order
 *
 * @remarks
 * A deterministic map-then-group over `Extraction.routeTo` + `parseWith`, so
 * this runner and the live tracker route through the one function
 * (`collector-fundamentals`' `extraction-parity.test.ts` pins it) and one bad
 * response never takes the run down. The `Effect` is infallible: every failure
 * mode is data, and the effect is only there because `parse` is effectful.
 */
const runExtraction = <TParsed>(
  responseKinds: readonly HttpResponseKind.HttpResponseKind<TParsed>[],
  responses: readonly Extraction.Input[]
): Effect.Effect<ExtractionResult<TParsed>> => {
  const duplicates = Extraction.findDuplicates(responses)
  return pipe(
    // Sequential (Effect.forEach's default), so outcomes — and therefore each
    // of the five groups below — keep input order.
    Effect.forEach(responses, (response) => outcomeOf(responseKinds, duplicates, response)),
    // One pass instead of `Array.groupBy`, which is string-keyed
    // (`Record<string, …>`) and would lose the union's narrowing.
    Effect.map((outcomes) => {
      const batches: Batch<TParsed>[] = []
      const unmatched: Extraction.ResponseRef[] = []
      const parseFailures: ParseFailure[] = []
      const bodyAbsent: BodyAbsent[] = []
      const dupes: Duplicate[] = []
      for (const outcome of outcomes) {
        switch (outcome._tag) {
          case 'batch':
            batches.push(outcome.value)
            break
          case 'unmatched':
            unmatched.push(outcome.value)
            break
          case 'parseFailure':
            parseFailures.push(outcome.value)
            break
          case 'bodyAbsent':
            bodyAbsent.push(outcome.value)
            break
          case 'duplicate':
            dupes.push(outcome.value)
            break
        }
      }
      return { batches, unmatched, parseFailures, bodyAbsent, duplicates: dupes }
    })
  )
}

export { runExtraction }
export type { Batch, BodyAbsent, Duplicate, ExtractionResult, ParseFailure }
