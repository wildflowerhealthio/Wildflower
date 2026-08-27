import { Array as Arr, Effect, Option, type ParseResult } from 'effect'

import type { FhirResource } from 'fhir-r4/resources'
import { Extraction, Source } from 'http-extraction-fundamentals'
import { type ArchivedExchange, fromHarJson } from 'web-trace-core/har'

import type * as ImportPreview from './import-preview.ts'
import { sources } from './sources.ts'

/**
 * Detect, extract, and preview a HAR archive — the read half of the import
 * flow, with nothing written.
 *
 * @remarks
 * `HarImport.run(harText)` decodes the archive, asks the closed
 * {@link sources} list which HTTP source claims its traffic, runs that
 * source's entities over the exchanges, and folds the result into an
 * {@link ImportPreview.ImportPreview}. A malformed archive is the only
 * failure; every other outcome — no source claims, a claim with parse
 * failures, unmatched noise, absent bodies — is data on the returned preview.
 *
 * **This module never persists.** Its Effect requires nothing (`R = never`), and
 * in particular not `FhirR4ResourcesHttpApiClient` — a preview is a pure
 * function of the archive text, so the write client is unreachable from here by
 * construction. Writing is `ImportPreview.persist`'s separate, opt-in step.
 */

/**
 * One archived exchange as the structural {@link Extraction.Input} the
 * extraction runner consumes.
 *
 * @param exchange - An exchange read out of the HAR archive
 * @returns The same eight fields, typed as an `Extraction.Input`
 *
 * @remarks
 * An {@link ArchivedExchange} and an `Extraction.Input` line up field-for-field —
 * `id`/`url`/`status`/`statusText`/`headers`/`startedAt`/`body`/`bodyAbsent`,
 * with `ArchivedExchange`'s `headers` (`HeadersWire`, an ordered `[name, value]`
 * list) being exactly `HttpResponse.Headers`. Restated explicitly rather
 * than passed through so a drift in either shape is a compile error here, at
 * the one seam the two packages meet — neither package imports the other, so
 * this is the only place their alignment is checked.
 */
const toInput = (exchange: ArchivedExchange): Extraction.Input => ({
  id: exchange.id,
  url: exchange.url,
  status: exchange.status,
  statusText: exchange.statusText,
  headers: exchange.headers,
  startedAt: exchange.startedAt,
  body: exchange.body,
  bodyAbsent: exchange.bodyAbsent,
})

/** Project the extraction's parse failures onto the preview's display shape. */
const toImportParseFailures = (
  parseFailures: readonly Extraction.ParseFailure[]
): readonly ImportPreview.ImportParseFailure[] =>
  parseFailures.map((failure) => ({ url: failure.url, error: failure.error }))

/**
 * The distinct source roots a claimed archive reached, in first-seen order.
 *
 * @param responses - The archive's responses, in input order
 * @param rootOf - The source's per-URL root reader (`fhir-r4-source`'s
 *   `fhirRootOf`)
 * @returns Every distinct root some response's URL named, de-duplicated but
 *   otherwise untouched — no single root chosen, no voting
 *
 * @remarks
 * One archive can reach several servers, and a source's entities key each
 * resource under the root of *its own* URL, so the pipeline must not collapse
 * those to one. This collects the full set rather than inferring a winner — the
 * same "keep every server apart, no voting" stance the entities take. URLs
 * that name no root (the browser noise around the FHIR traffic) contribute
 * nothing.
 */
const distinctRoots = (
  responses: readonly Extraction.Input[],
  rootOf: (url: string) => Option.Option<string>
): readonly string[] => Arr.dedupe(Arr.filterMap(responses, (response) => rootOf(response.url)))

/**
 * Run a claimed archive through its source's entities and fold the
 * extraction into a `Preview`.
 *
 * @remarks
 * The claim is the source's; from there this only extracts and accounts.
 * The source roots are the *set* the archive reached ({@link distinctRoots}),
 * not a single inferred one — a capture spanning two servers keeps both, and
 * each server's resources are already keyed apart under their own roots by the
 * source's entities.
 */
const previewClaimed = (
  source: Source.Source<FhirResource>,
  responses: readonly Extraction.Input[]
): Effect.Effect<ImportPreview.ImportPreview> =>
  Effect.map(Extraction.run(source.responseKinds, responses), (extraction) => ({
    _tag: 'Preview',
    sourceTag: source.tag,
    rootUrls: distinctRoots(responses, source.rootOf),
    resourcesByType: Arr.groupBy(
      extraction.batches.flatMap((batch) => batch.resources),
      (resource) => resource.resourceType
    ),
    parseFailures: toImportParseFailures(extraction.parseFailures),
    unmatchedCount: extraction.unmatched.length,
    bodyAbsentCount: extraction.bodyAbsent.length,
    totalEntries: responses.length,
  }))

/**
 * Read a `.har` file's text into an import preview.
 *
 * @param harText - The text of a `.har` file
 * @returns An {@link ImportPreview.ImportPreview} — a `Preview` when a
 *   registered source claims the traffic, `NoSourceClaims` when none does;
 *   failing only with a `ParseError` when the text is not a well-formed HAR
 *   archive
 *
 * @remarks
 * The pipeline is: decode the archive (`fromHarJson`), map its exchanges to the
 * structural inputs the extraction runner reads, resolve the most specific
 * registered source that claims them, and — if one does — run its entities
 * and fold the four-way extraction into the preview. No source claiming is a
 * `NoSourceClaims`, not an error.
 *
 * The returned Effect requires nothing. It cannot write, and specifically cannot
 * reach `FhirR4ResourcesHttpApiClient`; a preview is read-only by construction,
 * which is what makes the preview-then-confirm flow safe.
 */
const run = (harText: string): Effect.Effect<ImportPreview.ImportPreview, ParseResult.ParseError> =>
  Effect.gen(function* () {
    const session = yield* fromHarJson(harText)
    const responses = session.exchanges.map(toInput)
    const claimed = Source.resolve(sources, responses)
    if (Option.isNone(claimed)) {
      return { _tag: 'NoSourceClaims', totalEntries: responses.length }
    }
    return yield* previewClaimed(claimed.value, responses)
  })

export { run, toInput }
