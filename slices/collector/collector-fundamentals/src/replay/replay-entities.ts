import { Effect, Either, type DateTime, type ParseResult } from 'effect'

import type * as EntityDefinition from '../model/entity-definition.ts'
import { Response } from '../model/index.ts'

/**
 * One response to replay, as a plain struct — everything
 * {@link Response.RemoteResponse} carries, with the body already in hand.
 *
 * @remarks
 * The shape matches what a HAR reader produces (`web-trace-core`'s
 * `ParsedHarEntry`) *by shape only*: this package names no archive format and
 * depends on nothing that does, so a caller that reads its responses from
 * somewhere else (a fixture, a proxy log, a future capture format) feeds the
 * runner just as well.
 *
 * `bodyAbsent` is the archive's "the body was not captured" flag — distinct
 * from a genuinely empty body, which is `body: new Uint8Array()` with
 * `bodyAbsent: false`. A HAR entry can record the exchange while omitting its
 * content (`content.text` absent, a `_transferSize`-only entry, a body the
 * exporter dropped for size), and decoding that as an empty payload would
 * manufacture a parse failure for a response that was never in evidence — so
 * {@link replayEntities} reports it as its own outcome instead.
 */
interface ReplayResponse {
  readonly id: string
  readonly url: string
  readonly status: number
  readonly statusText: string
  readonly headers: Response.RemoteResponseHeaders
  readonly startedAt: DateTime.Utc
  readonly body: Uint8Array
  readonly bodyAbsent: boolean
}

/** The `(id, url)` pair every replay outcome is keyed by. */
interface ReplayResponseRef {
  readonly id: string
  readonly url: string
}

/**
 * What one matched, parsed response produced.
 *
 * @remarks
 * Per-response rather than one flat resource array: the importer's preview
 * shows which response yielded what, and flattening is a `flatMap` away for a
 * caller that doesn't care.
 */
interface ReplayBatch<TResources> extends ReplayResponseRef {
  readonly entityName: string
  readonly resources: readonly TResources[]
}

/** A matched response whose `parse` failed. Data, not a fold-aborting error. */
interface ReplayParseFailure extends ReplayResponseRef {
  readonly entityName: string
  readonly error: ParseResult.ParseError
}

/**
 * A matched response the archive carried no body for — see
 * {@link ReplayResponse.bodyAbsent}. `parse` was never called.
 */
interface ReplayBodyAbsent extends ReplayResponseRef {
  readonly entityName: string
}

/**
 * The complete accounting of a replay: every input response lands in exactly
 * one of the four arrays, each in input order.
 *
 * @remarks
 * Nothing here is an error channel. A response no entity claimed
 * (`unmatched`), one whose decode failed (`parseFailures`), and one the
 * archive recorded without a body (`bodyAbsent`) are all ordinary outcomes of
 * replaying traffic that was never captured for this purpose — a caller
 * reports them, it does not recover from them.
 */
interface ReplayOutcome<TResources> {
  readonly batches: readonly ReplayBatch<TResources>[]
  readonly unmatched: readonly ReplayResponseRef[]
  readonly parseFailures: readonly ReplayParseFailure[]
  readonly bodyAbsent: readonly ReplayBodyAbsent[]
}

/**
 * WARN once (not per response) for every entity that declares
 * `followUpSteps`.
 *
 * @remarks
 * Follow-up generation drives *navigation* — there is nothing offline to
 * navigate, and the archive already contains whatever the live run's
 * generated steps fetched. Ignoring it silently would let a plan behave
 * differently here than it reads, so the ignore is announced once at the top
 * of the fold rather than buried in a per-response branch.
 */
const warnIgnoredFollowUpSteps = <TResources>(
  entityDefinitions: readonly EntityDefinition.EntityDefinition<TResources>[]
): Effect.Effect<void> => {
  const generating = entityDefinitions.filter((entity) => entity.followUpSteps !== undefined)
  return generating.length === 0
    ? Effect.void
    : Effect.logWarning(
        `replayEntities: ignoring followUpSteps declared by ${generating
          .map((entity) => entity.name)
          .join(', ')}; offline replay performs no navigation`
      )
}

/**
 * Replay a static set of responses through a collector's entities.
 *
 * @typeParam TResources - The resource type the entities decode to
 * @param entityDefinitions - The plan's entities, in plan order; the first
 *   whose `isFoundAt` matches a response's URL claims it
 * @param responses - The responses to replay, in the order they should be seen
 * @returns The four-way {@link ReplayOutcome} accounting — batches, unmatched,
 *   parse failures, absent bodies — each in input order
 *
 * @remarks
 * A deterministic fold, and the offline half of what
 * `CollectorBridgeMessageHandler` does live: same list-order,
 * first-`isFoundAt`-match-wins routing (so a plan's silent ordering
 * dependencies behave identically both ways — see the slice's guardrail on
 * overlapping patterns), same `RemoteResponse` handed to `parse`, same
 * "one bad response never takes the run down" isolation.
 *
 * What the live path does and this does not: no navigation, no timeouts, no
 * cancellation (there is no page to drive), no `followUpSteps` (WARN-ignored,
 * above), and no `captureProvenance` — an offline import's provenance is its
 * source archive, one artifact linked once, not a per-response trace.
 *
 * **The runner does not persist.** It hands back what it decoded; writing is
 * the caller's separate, opt-in step. That is what makes a preview-then-confirm
 * flow possible, and it keeps the runner a pure function of its inputs.
 *
 * The `Effect` is infallible (`never` in the error channel): every failure mode
 * is reported as data, and the effect is only there because `parse` is
 * effectful and the follow-up warning logs.
 */
const replayEntities = <TResources>(
  entityDefinitions: readonly EntityDefinition.EntityDefinition<TResources>[],
  responses: readonly ReplayResponse[]
): Effect.Effect<ReplayOutcome<TResources>> =>
  Effect.gen(function* () {
    yield* warnIgnoredFollowUpSteps(entityDefinitions)

    const batches: ReplayBatch<TResources>[] = []
    const unmatched: ReplayResponseRef[] = []
    const parseFailures: ReplayParseFailure[] = []
    const bodyAbsent: ReplayBodyAbsent[] = []

    for (const source of responses) {
      const ref: ReplayResponseRef = { id: source.id, url: source.url }
      const entity = entityDefinitions.find((candidate) => candidate.isFoundAt(source.url))
      if (entity === undefined) {
        unmatched.push(ref)
        continue
      }
      if (source.bodyAbsent) {
        bodyAbsent.push({ ...ref, entityName: entity.name })
        continue
      }

      const response = new Response.RemoteResponse(
        source.id,
        source.url,
        source.status,
        source.statusText,
        source.headers,
        source.startedAt
      )
      // A zero-length body appends nothing, so `chunkCount` matches the live
      // path (where an empty body produces no `ResponseData` event); `bytes()`
      // is the empty array either way.
      if (source.body.length > 0) {
        response.appendChunk(source.body)
      }

      const parsed = yield* Effect.either(entity.parse(response))
      if (Either.isLeft(parsed)) {
        parseFailures.push({ ...ref, entityName: entity.name, error: parsed.left })
        continue
      }
      batches.push({ ...ref, entityName: entity.name, resources: parsed.right })
    }

    return { batches, unmatched, parseFailures, bodyAbsent }
  })

export { replayEntities }
export type {
  ReplayBatch,
  ReplayBodyAbsent,
  ReplayOutcome,
  ReplayParseFailure,
  ReplayResponse,
  ReplayResponseRef,
}
