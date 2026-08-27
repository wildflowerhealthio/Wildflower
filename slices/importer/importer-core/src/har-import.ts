import { Array as Arr, Effect, Option, type ParseResult } from 'effect'

import { Extraction } from 'http-extraction-fundamentals'
import { type ArchivedExchange, fromHarJson } from 'web-trace-core/har'

import type * as ImportPreview from './import-preview.ts'
import { pool } from './sources.ts'

/**
 * Detect, extract, and preview a HAR archive — the read half of the import
 * flow, with nothing written.
 *
 * @remarks
 * `HarImport.run(harText)` decodes the archive, runs the closed {@link pool}
 * over its exchanges per-URL (`Extraction.run`, routing each response to the
 * highest-specificity kind that recognizes it), and folds the result into an
 * {@link ImportPreview.Preview}. A malformed archive is the only failure; every
 * other outcome — nothing recognized, decode failures, unmatched noise, absent
 * bodies — is data on the returned preview.
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
 * The distinct `source.system`s the archive's recognized responses named, in
 * first-seen order.
 *
 * @param responses - The archive's responses, in input order
 * @returns Every distinct `source.system` some response routed to, de-duplicated
 *   but otherwise untouched — no single root chosen, no voting
 *
 * @remarks
 * Read straight off recognition (`Extraction.routeTo` per response, the same
 * routing `Extraction.run` uses), rather than a separate root reader: the root a
 * resource keys under *is* its kind's `tryRecognize` source. One archive can
 * reach several servers, so this collects the full set rather than inferring a
 * winner. Responses no kind recognizes, and ones whose kind mints no `source`
 * (a recorder), contribute nothing.
 */
const distinctSourceSystems = (responses: readonly Extraction.Input[]): readonly string[] =>
  Arr.dedupe(
    Arr.filterMap(responses, (response) =>
      Option.flatMap(Extraction.routeTo(pool, response.url), (routed) =>
        Option.fromNullable(routed.recognized.source?.system)
      )
    )
  )

/**
 * Read a `.har` file's text into an import preview.
 *
 * @param harText - The text of a `.har` file
 * @returns An {@link ImportPreview.Preview} — always a preview, failing only with
 *   a `ParseError` when the text is not a well-formed HAR archive
 *
 * @remarks
 * The pipeline is: decode the archive (`fromHarJson`), map its exchanges to the
 * structural inputs the extraction runner reads, run the flat pool over them
 * per-URL (`Extraction.run`), and fold the four-way extraction into the preview.
 * An archive nothing recognized is a preview whose batches are empty
 * (`unmatchedCount === totalResponses`), not a distinct outcome.
 *
 * The returned Effect requires nothing. It cannot write, and specifically cannot
 * reach `FhirR4ResourcesHttpApiClient`; a preview is read-only by construction,
 * which is what makes the preview-then-confirm flow safe.
 */
const run = (harText: string): Effect.Effect<ImportPreview.Preview, ParseResult.ParseError> =>
  Effect.gen(function* () {
    const session = yield* fromHarJson(harText)
    const responses = session.exchanges.map(toInput)
    const extraction = yield* Extraction.run(pool, responses)
    return {
      rootUrls: distinctSourceSystems(responses),
      resourcesByType: Arr.groupBy(
        extraction.batches.flatMap((batch) => batch.resources),
        (resource) => resource.resourceType
      ),
      parseFailures: toImportParseFailures(extraction.parseFailures),
      unmatchedCount: extraction.unmatched.length,
      bodyAbsentCount: extraction.bodyAbsent.length,
      totalResponses: responses.length,
    }
  })

export { run, toInput }
