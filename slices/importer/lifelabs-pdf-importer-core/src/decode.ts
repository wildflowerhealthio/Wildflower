import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import type { DecodedFile, PickedFile } from '@wildflowerhealthio/importer-fundamentals'
import { checkTimeZone } from '@wildflowerhealthio/kitchen-sink'
import {
  type Document,
  PositionedTextExtractor,
  type UnreadablePdf,
} from '@wildflowerhealthio/positioned-text'
import { Effect, ParseResult, Schema } from 'effect'

import * as Report from './entities/report.ts'
import type { LifeLabsPdfSettings } from './settings.ts'
import { adoptedResourcesOf } from './synthesis.ts'

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

/** An adopted resource as its review row, keyed and titled by its `Type/id`. */
const labelAdopted = (adopted: FhirResourceWithId): DecodedFile.Resource => {
  const literalReference = `${adopted.resourceType}/${adopted.id}`
  return { key: literalReference, title: literalReference, resource: adopted }
}

/**
 * The section title one report's resources are reviewed under: the report's
 * own printed identity — its `Lab No` and date of service — with a generic
 * fallback when the report masks both.
 */
const reportSectionTitle = (report: Report.Type): string => {
  const labNo = report.labNo.trim()
  const dateOfService = report.dateOfService.trim()
  const parts = [labNo === '' ? '' : `Lab No ${labNo}`, dateOfService].filter((part) => part !== '')
  return parts.length === 0 ? 'LifeLabs report' : parts.join(' — ')
}

/**
 * Decode a positioned-text document into per-report sections of adopted,
 * labeled FHIR resources — the pure "document → sections" leg the outer
 * decode wraps.
 *
 * @param document - The positioned-text document the
 *   {@link PositionedTextExtractor} produced from the PDF's bytes
 * @param settings - The import's settings (time zone for date interpretation)
 * @returns One section per report the document carries (titled by the
 *   report's `Lab No` and date of service), no notes; fails only with a
 *   `ParseError` when the document is not a recognized LifeLabs report;
 *   requires nothing
 *
 * @remarks
 * Exported so property tests can drive it directly, feeding `layoutDocument`'s
 * printed inverse instead of going through an extractor.
 * `decodeLifeLabsPdf` is `decodeLifeLabsPdfDocument ∘ PositionedTextExtractor`.
 * A `Patient` or `Practitioner` shared across reports appears in the section
 * of the first report naming it — the synthesis deduplicates by id.
 */
const decodeLifeLabsPdfDocument = (
  document: Document.Type,
  settings: LifeLabsPdfSettings
): Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError> =>
  Effect.gen(function* () {
    const timeZone = yield* checkTimeZone(settings.timeZone)
    const reports = yield* Report.tryFromDocument(document).pipe(Effect.mapError(asParseError))
    const groups = yield* adoptedResourcesOf(reports, { timeZone })
    const sections = groups.map((group): DecodedFile.Section => ({
      title: reportSectionTitle(group.report),
      resources: group.resources.map(labelAdopted),
    }))
    return { sections, notes: [] }
  })

/**
 * Decode one picked LifeLabs report PDF into per-report sections of adopted,
 * labeled FHIR resources — the one-file set the importer's `decode` reads.
 *
 * @param file - The picked file, whose `bytes` are a LifeLabs "Reports" PDF
 *   exactly as the picker read them
 * @param settings - The import's settings (time zone for date interpretation)
 * @returns One section of `LabeledResource`s per report, no notes; fails only
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
): Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError, PositionedTextExtractor> =>
  Effect.gen(function* () {
    const extractor = yield* PositionedTextExtractor
    const document = yield* extractor.extract(file.bytes).pipe(Effect.mapError(asParseError))
    return yield* decodeLifeLabsPdfDocument(document, settings)
  })

export { decodeLifeLabsPdf, decodeLifeLabsPdfDocument, reportSectionTitle }
