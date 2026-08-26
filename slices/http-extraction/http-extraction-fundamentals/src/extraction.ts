import { Effect, Either, type ParseResult } from 'effect'

import type * as EntityDefinition from './entity-definition.ts'
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
 * Run a static set of archived responses through a source's entities.
 *
 * @typeParam TResources - The resource type the entities decode to
 * @param entityDefinitions - The source's entities, in list order; the
 *   first whose `isFoundAt` matches a response's URL claims it
 * @param responses - The responses to extract from, in the order they should
 *   be seen
 * @returns The four-way {@link Extraction} accounting — batches, unmatched,
 *   parse failures, absent bodies — each in input order
 *
 * @remarks
 * A deterministic fold: same list-order, first-`isFoundAt`-match-wins routing
 * every consumer of an entity list uses (so a list's silent ordering
 * dependencies behave identically everywhere — keep overlapping patterns
 * disjoint), same {@link HttpResponse.HttpResponse} handed to
 * `parse`, same "one bad response never takes the run down" isolation.
 * `collector-fundamentals`' `extraction-parity.test.ts` pins that its live
 * sniffer path routes and decodes identically.
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
  entityDefinitions: readonly EntityDefinition.EntityDefinition<TResources>[],
  responses: readonly Input[]
): Effect.Effect<Extraction<TResources>> =>
  Effect.gen(function* () {
    const batches: Batch<TResources>[] = []
    const unmatched: ResponseRef[] = []
    const parseFailures: ParseFailure[] = []
    const bodyAbsent: BodyAbsent[] = []

    for (const source of responses) {
      const ref: ResponseRef = { id: source.id, url: source.url }
      const entity = entityDefinitions.find((candidate) => candidate.isFoundAt(source.url))
      if (entity === undefined) {
        unmatched.push(ref)
        continue
      }
      if (source.bodyAbsent) {
        bodyAbsent.push({ ...ref, entityName: entity.name })
        continue
      }

      const parsed = yield* Effect.either(entity.parse(HttpResponse.make(source)))
      if (Either.isLeft(parsed)) {
        parseFailures.push({ ...ref, entityName: entity.name, error: parsed.left })
        continue
      }
      batches.push({ ...ref, entityName: entity.name, resources: parsed.right })
    }

    return { batches, unmatched, parseFailures, bodyAbsent }
  })

export { run }
export type { Batch, BodyAbsent, Extraction, Input, ParseFailure, ResponseRef }
