import { DateTime, Effect, Option, ParseResult, Schema } from 'effect'
import { adoptResource } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type {
  DecodedFile,
  LabeledResource,
  LabeledSection,
  PickedFile,
  SourceFile,
} from 'importer-fundamentals'
import type { Document } from 'positioned-text'
import { extractPositionedText } from 'positioned-text-web'

import * as Report from './entities/report.ts'
import { toFhirResources } from './fhir/to-fhir.ts'
import type { LifeLabsPdfSettings } from './settings.ts'
import { LIFELABS_SYSTEM } from './source-system.ts'

const adopt = adoptResource({ system: LIFELABS_SYSTEM })

/** A zone name the runtime does not know is a parse failure, not a defect. */
const checkTimeZone = (timeZone: string): Effect.Effect<string, ParseResult.ParseError> => {
  if (Option.isSome(DateTime.zoneMakeNamed(timeZone))) return Effect.succeed(timeZone)
  return Effect.fail(
    new ParseResult.ParseError({
      issue: new ParseResult.Type(
        Schema.String.ast,
        timeZone,
        `"${timeZone}" is not an IANA time zone name`
      ),
    })
  )
}

/**
 * Wrap the report-parse's `UnrecognizedLifeLabsDocument` as a `ParseError` so
 * `decodeLifeLabsPdf` keeps a single, format-shaped error channel — the
 * descriptor contract's `ParseError`. `Forbidden` is the right issue kind: the
 * PDF's text extracted successfully, but the transform to a LifeLabs report
 * refused it.
 */
const unrecognizedAsParseError = (e: Report.UnrecognizedLifeLabsDocument): ParseResult.ParseError =>
  new ParseResult.ParseError({
    issue: new ParseResult.Forbidden(Schema.Unknown.ast, undefined, e.message),
  })

/**
 * A pdfjs extraction failure — the bytes were not a PDF the extractor could
 * open — surfaces as a `ParseError` too, so the descriptor's decode has one
 * failure channel.
 */
const extractionAsParseError = (cause: unknown): ParseResult.ParseError =>
  new ParseResult.ParseError({
    issue: new ParseResult.Forbidden(
      Schema.Unknown.ast,
      undefined,
      cause instanceof Error ? cause.message : 'PDF extraction failed'
    ),
  })

/**
 * Every resource `toFhirResources` mints carries a derived id, and `adoptResource`
 * only ever nulls out an id it started with; so after synthesis+adoption every
 * resource must have one. A null here is an unreachable invariant break — die
 * rather than paper over it with a shared `'?'` key that would collide across
 * resources and defeat `StagedImport.Selection`.
 */
const labelAdopted = (resource: FhirResource): LabeledResource<FhirResource> => {
  const adopted = adopt(resource)
  const type = adopted.resourceType
  const id = adopted.id
  if (id === null) {
    throw new Error(
      `unreachable: adopted ${type} has no id — toFhirResources mints one for every resource`
    )
  }
  return { key: `${type}/${id}`, title: `${type}/${id}`, resource: adopted }
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
 * @param document - The positioned-text document {@link extractPositionedText}
 *   produced from the PDF's bytes
 * @param settings - The import's settings (time zone for date interpretation)
 * @returns One section per report the document carries (titled by the
 *   report's `Lab No` and date of service), no notes; fails only with a
 *   `ParseError` when the document is not a recognized LifeLabs report;
 *   requires nothing
 *
 * @remarks
 * Exported so property tests can drive it directly, feeding `layoutDocument`'s
 * printed inverse instead of round-tripping through the pdfjs extraction seam.
 * `decodeLifeLabsPdf` is `decodeLifeLabsPdfDocument ∘ extractPositionedText`.
 * A `Patient` or `Practitioner` shared across reports appears in the section
 * of the first report naming it — the synthesis deduplicates by id.
 */
const decodeLifeLabsPdfDocument = (
  document: Document.Type,
  settings: LifeLabsPdfSettings
): Effect.Effect<DecodedFile<FhirResource>, ParseResult.ParseError> =>
  Effect.gen(function* () {
    const timeZone = yield* checkTimeZone(settings.timeZone)
    const reports = yield* Report.tryFromDocument(document).pipe(
      Effect.mapError(unrecognizedAsParseError)
    )
    const groups = yield* toFhirResources(reports, { timeZone })
    const sections = groups.map((group): LabeledSection<FhirResource> => ({
      title: reportSectionTitle(group.report),
      resources: group.resources.map(labelAdopted),
    }))
    return { sections, notes: [] }
  })

/**
 * Decode one picked LifeLabs report PDF into per-report sections of adopted,
 * labeled FHIR resources — the per-file decode the descriptor's `decode`
 * lifts through `perFileDecode`.
 *
 * @param file - The picked file, whose `bytes` are a LifeLabs "Reports" PDF
 *   exactly as the picker read them
 * @param settings - The import's settings (time zone for date interpretation)
 * @param _source - The file's source-file reference, unused: this format's
 *   resources carry no id derived from their source file, and `perFileDecode`
 *   stamps `meta.source` itself
 * @returns One section of `LabeledResource`s per report, no notes; fails only
 *   with a `ParseError` when the bytes are not a PDF the extractor can open or
 *   the extracted text is not a recognized LifeLabs report; requires nothing
 *
 * @remarks
 * The extraction seam is `positioned-text-web`'s `extractPositionedText`, the
 * same one the PDF anonymizer uses to turn a PDF into a positioned-text
 * document — so the importer and the anonymizer read the identical byte
 * layout, and any dialect-level improvement here is picked up by the
 * anonymizer's preview too. Nothing here reads text off disk: the LifeLabs
 * report PDF the user picks is the format's own input, not the anonymizer's
 * JSON download.
 */
const decodeLifeLabsPdf = (
  file: PickedFile,
  settings: LifeLabsPdfSettings,
  _source: SourceFile.Ref
): Effect.Effect<DecodedFile<FhirResource>, ParseResult.ParseError> =>
  Effect.tryPromise({
    try: () => extractPositionedText(file.bytes),
    catch: extractionAsParseError,
  }).pipe(Effect.flatMap((document) => decodeLifeLabsPdfDocument(document, settings)))

export { decodeLifeLabsPdf, decodeLifeLabsPdfDocument, reportSectionTitle }
