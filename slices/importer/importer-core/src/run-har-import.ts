import { Effect, Option, type ParseResult } from 'effect'

import { Recognizer, Replay } from 'collector-fundamentals/replay'
import type { FhirResource } from 'fhir-r4/resources'
import { type ArchivedExchange, fromHarJson } from 'web-trace-core/har'

import type { ImportParseFailure, ImportPreview } from './import-preview.ts'
import { REGISTERED_COLLECTORS, type RegisteredCollector } from './registered-collectors.ts'

/**
 * Detect, replay, and preview a HAR archive — the read half of the import flow,
 * with nothing written.
 *
 * @remarks
 * `runHarImport(harText)` decodes the archive, asks the closed
 * {@link REGISTERED_COLLECTORS} list which collector claims its traffic, replays
 * that collector's offline entities over the exchanges, and folds the result
 * into an {@link ImportPreview}. A malformed archive is the only failure; every
 * other outcome — no collector claims, a claim with parse failures, unmatched
 * noise, absent bodies — is data on the returned preview.
 *
 * **This module never persists.** Its Effect requires nothing (`R = never`), and
 * in particular not `FhirR4ResourcesHttpApiClient` — a preview is a pure
 * function of the archive text, so the write client is unreachable from here by
 * construction. Writing is {@link persistPreview}'s separate, opt-in step.
 */

/**
 * One archived exchange as the structural {@link Replay.ReplayResponse} the
 * replay runner consumes.
 *
 * @param exchange - An exchange read out of the HAR archive
 * @returns The same eight fields, typed as a `ReplayResponse`
 *
 * @remarks
 * An {@link ArchivedExchange} and a `ReplayResponse` line up field-for-field —
 * `id`/`url`/`status`/`statusText`/`headers`/`startedAt`/`body`/`bodyAbsent`,
 * with `ArchivedExchange`'s `headers` (`HeadersWire`, an ordered `[name, value]`
 * list) being exactly `ReplayResponse`'s `RemoteResponseHeaders`. Restated
 * explicitly rather than passed through so a drift in either shape is a compile
 * error here, at the one seam the two packages meet — neither package imports
 * the other, so this is the only place their alignment is checked.
 */
const toReplayResponse = (exchange: ArchivedExchange): Replay.ReplayResponse => ({
  id: exchange.id,
  url: exchange.url,
  status: exchange.status,
  statusText: exchange.statusText,
  headers: exchange.headers,
  startedAt: exchange.startedAt,
  body: exchange.body,
  bodyAbsent: exchange.bodyAbsent,
})

/**
 * Group a replay outcome's decoded resources by FHIR `resourceType`.
 *
 * @param batches - The resource-producing batches of a `ReplayOutcome`
 * @returns The resources keyed by `resourceType`, in first-seen order within
 *   each type
 */
const groupByResourceType = (
  batches: readonly Replay.ReplayBatch<FhirResource>[]
): Readonly<Record<string, readonly FhirResource[]>> => {
  const grouped: Record<string, FhirResource[]> = {}
  for (const batch of batches) {
    for (const resource of batch.resources) {
      ;(grouped[resource.resourceType] ??= []).push(resource)
    }
  }
  return grouped
}

/** Project the replay's parse failures onto the preview's display shape. */
const toImportParseFailures = (
  parseFailures: readonly Replay.ReplayParseFailure[]
): readonly ImportParseFailure[] =>
  parseFailures.map((failure) => ({ url: failure.url, error: failure.error }))

/**
 * The distinct source roots a claimed archive reached, in first-seen order.
 *
 * @param responses - The archive's responses, in input order
 * @param rootOf - The collector's per-URL root reader (`fhir-r4-client-collector`'s
 *   `fhirRootOf`)
 * @returns Every distinct root some response's URL named, de-duplicated but
 *   otherwise untouched — no single root chosen, no voting
 *
 * @remarks
 * One archive can reach several servers, and the offline entities key each
 * resource under the root of *its own* URL, so the importer must not collapse
 * those to one. This collects the full set rather than inferring a winner — the
 * same "keep every server apart, no voting" stance the offline surface takes.
 * URLs that name no root (the browser noise around the FHIR traffic) contribute
 * nothing.
 */
const distinctRoots = (
  responses: readonly Replay.ReplayResponse[],
  rootOf: (url: string) => Option.Option<string>
): readonly string[] => {
  const seen = new Set<string>()
  const roots: string[] = []
  for (const response of responses) {
    const root = rootOf(response.url)
    if (Option.isSome(root) && !seen.has(root.value)) {
      seen.add(root.value)
      roots.push(root.value)
    }
  }
  return roots
}

/**
 * Replay a claimed archive and fold the outcome into a `Preview`.
 *
 * @remarks
 * The claim is the recognizer's; from there this only replays and accounts. The
 * source roots are the *set* the archive reached ({@link distinctRoots}), not a
 * single inferred one — a capture spanning two servers keeps both, and each
 * server's resources are already keyed apart under their own roots by the
 * offline entities.
 */
const previewClaimed = (
  collector: RegisteredCollector,
  responses: readonly Replay.ReplayResponse[]
): Effect.Effect<ImportPreview> =>
  Effect.map(Replay.replayEntities(collector.offlineEntities, responses), (outcome) => ({
    _tag: 'Preview',
    collectorTag: collector.tag,
    rootUrls: distinctRoots(responses, collector.rootOf),
    resourcesByType: groupByResourceType(outcome.batches),
    parseFailures: toImportParseFailures(outcome.parseFailures),
    unmatchedCount: outcome.unmatched.length,
    bodyAbsentCount: outcome.bodyAbsent.length,
    totalEntries: responses.length,
  }))

/**
 * Read a `.har` file's text into an import preview.
 *
 * @param harText - The text of a `.har` file
 * @returns An {@link ImportPreview} — a `Preview` when a registered collector
 *   claims the traffic, `NoCollectorClaims` when none does; failing only with a
 *   `ParseError` when the text is not a well-formed HAR archive
 *
 * @remarks
 * The pipeline is: decode the archive (`fromHarJson`), map its exchanges to the
 * structural responses the replay runner reads, resolve the most specific
 * registered collector that claims them, and — if one does — replay its offline
 * entities and fold the four-way outcome into the preview. No collector claiming
 * is a `NoCollectorClaims`, not an error.
 *
 * The returned Effect requires nothing. It cannot write, and specifically cannot
 * reach `FhirR4ResourcesHttpApiClient`; a preview is read-only by construction,
 * which is what makes the preview-then-confirm flow safe.
 */
const runHarImport = (harText: string): Effect.Effect<ImportPreview, ParseResult.ParseError> =>
  Effect.gen(function* () {
    const session = yield* fromHarJson(harText)
    const responses = session.exchanges.map(toReplayResponse)
    const claimed = Recognizer.resolve(REGISTERED_COLLECTORS, responses)
    if (Option.isNone(claimed)) {
      return { _tag: 'NoCollectorClaims', totalEntries: responses.length }
    }
    return yield* previewClaimed(claimed.value, responses)
  })

export { groupByResourceType, runHarImport, toReplayResponse }
