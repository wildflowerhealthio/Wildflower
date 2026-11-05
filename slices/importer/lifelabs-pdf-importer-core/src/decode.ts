import type { DecodeFunction, PickedFile } from '@wildflowerhealthio/importer-fundamentals'
import { checkTimeZone } from '@wildflowerhealthio/kitchen-sink'
import {
  type Document,
  PositionedTextExtractor,
  type UnreadablePdf,
} from '@wildflowerhealthio/positioned-text'
import { Effect, ParseResult, Schema } from 'effect'

import * as Report from './entities/report.ts'
import type { LifeLabsPdfSettings } from './settings.ts'
import { decodedReportsOf } from './synthesis.ts'

/**
 * Wrap a refusal as a `ParseError` so `decodeLifeLabsPdf` keeps a single,
 * format-shaped error channel — the importer contract's `ParseError`. The
 * refusal is the extractor's `UnreadablePdf` (the bytes were not a PDF it could
 * open) or the report-parse's `UnrecognizedLifeLabsDocument` (the text
 * extracted, but the transform to a LifeLabs report refused it). `Forbidden`
 * is the issue kind for both: the decode refused its input.
 */
const asParseError = (
  e: UnreadablePdf | Report.UnrecognizedLifeLabsDocument
): ParseResult.ParseError =>
  new ParseResult.ParseError({
    issue: new ParseResult.Forbidden(Schema.Unknown.ast, undefined, e.message),
  })

/** The note a page that prints no `Lab No` earns: it belongs to no report. */
const pageWithoutLabNoNote = (pageNumber: number): string =>
  `Page ${pageNumber} prints no Lab No, so it was skipped.`

/**
 * Decode a positioned-text document into per-report sections of labeled,
 * detached FHIR resources — the pure "document → sections" leg the outer
 * decode wraps.
 *
 * @param document - The positioned-text document the
 *   {@link PositionedTextExtractor} produced from the PDF's bytes
 * @param settings - The import's settings (time zone for date interpretation)
 * @returns The document's reports as {@link decodedReportsOf} yields them:
 *   one section per report, titled by its `Lab No` and date of service, its
 *   records detached and keyed by what the report prints, with a note for
 *   each page skipped for printing no `Lab No`; fails only with a
 *   `ParseError` when the document is not a recognized LifeLabs report;
 *   requires nothing
 *
 * @remarks
 * Exported so property tests can drive it directly, feeding `layoutDocument`'s
 * printed inverse instead of going through an extractor.
 * `decodeLifeLabsPdf` is `decodeLifeLabsPdfDocument ∘ PositionedTextExtractor`.
 * A `Patient` or `Practitioner` shared across reports appears in the section
 * of the first report naming it — the synthesis deduplicates by key.
 */
const decodeLifeLabsPdfDocument = (
  document: Document.Type,
  settings: LifeLabsPdfSettings
): Effect.Effect<DecodeFunction.FileSetDecode, ParseResult.ParseError> =>
  Effect.gen(function* () {
    const timeZone = yield* checkTimeZone(settings.timeZone)
    const { reports, pagesWithoutLabNo } = yield* Report.tryFromDocument(document).pipe(
      Effect.mapError(asParseError)
    )
    const decoded = yield* decodedReportsOf(reports, { timeZone })
    return { ...decoded, notes: [...pagesWithoutLabNo.map(pageWithoutLabNoNote), ...decoded.notes] }
  })

/**
 * Decode one picked LifeLabs report PDF into per-report sections of labeled,
 * detached FHIR resources — the one-file set the importer's `decode` reads.
 *
 * @param file - The picked file, whose `bytes` are a LifeLabs "Reports" PDF
 *   exactly as the picker read them
 * @param settings - The import's settings (time zone for date interpretation)
 * @returns One section per report, and a note per page skipped for printing
 *   no `Lab No`; fails only
 *   with a `ParseError` when the bytes are not a PDF the extractor can open or
 *   the extracted text is not a recognized LifeLabs report; requires the
 *   {@link PositionedTextExtractor}
 *
 * @remarks
 * The extractor is the caller's to provide. A host provides
 * `positioned-text-web`'s pdfjs layer, the same pdfjs extraction the PDF
 * anonymizer runs, so the importer and the anonymizer read the identical byte
 * layout and any dialect-level improvement here is picked up by the
 * anonymizer's preview too. Nothing here reads text off disk: the LifeLabs
 * report PDF the user picks is the format's own input, not the anonymizer's
 * JSON download.
 */
const decodeLifeLabsPdf = (
  file: PickedFile.NamedBytes,
  settings: LifeLabsPdfSettings
): Effect.Effect<DecodeFunction.FileSetDecode, ParseResult.ParseError, PositionedTextExtractor> =>
  Effect.gen(function* () {
    const extractor = yield* PositionedTextExtractor
    const document = yield* extractor.extract(file.bytes).pipe(Effect.mapError(asParseError))
    return yield* decodeLifeLabsPdfDocument(document, settings)
  })

export { decodeLifeLabsPdf, decodeLifeLabsPdfDocument }
