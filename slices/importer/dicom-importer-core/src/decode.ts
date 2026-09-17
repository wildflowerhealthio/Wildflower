/**
 * Decode a DICOM file into one section of FHIR resources and diagnostic
 * notes — the per-file decode `perFileDecode` lifts into the descriptor's
 * `decode`. A `dicom-parser` failure is a `ParseError`.
 *
 * @packageDocumentation
 */
import type { DicomHeader } from 'dicom'
import { parseDicomFile } from 'dicom'
import { DateTime, Effect, Either, Option, ParseResult, Schema } from 'effect'
import { adoptResource } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { DecodedFile, PickedFile, SourceFile } from 'importer-fundamentals'

import { toFhirResources, patientOriginalId } from './fhir/to-fhir.ts'
import type { DicomSettings } from './settings.ts'
import { DICOM_SYSTEM } from './source-system.ts'

const adopt = adoptResource({ system: DICOM_SYSTEM })

const dicomParseAsParseError = (reason: string): ParseResult.ParseError =>
  new ParseResult.ParseError({
    issue: new ParseResult.Forbidden(Schema.Unknown.ast, undefined, reason),
  })

/**
 * A zone name the runtime does not know is a parse failure, not a defect: the
 * setting is user-typed, and every `ImagingStudy.started` this decode emits is
 * resolved against it, so guessing a substitute would write instants hours
 * away from the ones the equipment recorded.
 */
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

const labelAdopted = (resource: FhirResource, key: string, title: string): DecodedFile.Resource => {
  const adopted = adopt(resource)
  return { key, title, resource: adopted }
}

/**
 * Build the section title from the header:
 * `<Modality> <StudyDescription> ·<StudyDate>`, falling back to
 * `DICOM study` when nothing is available.
 */
const sectionTitle = (header: DicomHeader): string => {
  const parts: string[] = []
  if (header.modality !== undefined) parts.push(header.modality)
  if (header.studyDescription !== undefined) parts.push(header.studyDescription)
  const prefix = parts.length === 0 ? 'DICOM study' : parts.join(' ')
  if (header.studyDate !== undefined) {
    const y = header.studyDate.slice(0, 4)
    const m = header.studyDate.slice(4, 6)
    const d = header.studyDate.slice(6, 8)
    return `${prefix} · ${y}-${m}-${d}`
  }
  return prefix
}

/**
 * Decode a picked DICOM file into sections of adopted, labeled FHIR
 * resources.
 *
 * @param file - The picked `.dcm` file, name and raw bytes
 * @param settings - The import's settings; its `timeZone` is what every
 *   `ImagingStudy.started` is resolved against
 * @param source - The file's resolved source-file `DocumentReference`; its
 *   `id` is what the `ImagingStudy` instance carries as its `gridfsFileId`
 *   extension, so the link names the resource the shell writes
 * @returns One section when the file carries at least a patient, plus notes
 *   for anything that could not be extracted; fails with a `ParseError` when
 *   the bytes cannot be parsed as DICOM, or when `settings.timeZone` is not an
 *   IANA time zone name
 */
const decodeDicom = (
  file: PickedFile,
  settings: DicomSettings,
  source: SourceFile.Ref
): Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError> =>
  Effect.gen(function* () {
    yield* checkTimeZone(settings.timeZone)

    const parseResult = parseDicomFile(file.bytes)
    if (Either.isLeft(parseResult)) {
      return yield* Effect.fail(dicomParseAsParseError(parseResult.left.reason))
    }

    const header = parseResult.right
    const notes: string[] = []

    if (patientOriginalId(header) === undefined) {
      notes.push('No patient identity in the DICOM header (no PatientID or PatientName).')
      return { sections: [], notes }
    }

    if (header.accessionNumber === undefined) {
      notes.push('No AccessionNumber — no ServiceRequest will be created.')
    }

    const resources = yield* toFhirResources(header, settings, source.id)
    const labeled: DecodedFile.Resource[] = []

    for (const resource of resources) {
      switch (resource.resourceType) {
        case 'Patient':
          labeled.push(labelAdopted(resource, 'patient', `Patient/${resource.id}`))
          break
        case 'ServiceRequest':
          labeled.push(labelAdopted(resource, 'service-request', `ServiceRequest/${resource.id}`))
          break
        case 'ImagingStudy':
          labeled.push(labelAdopted(resource, 'imaging-study', `ImagingStudy/${resource.id}`))
          break
        default:
          break
      }
    }

    const sections: DecodedFile.Section[] =
      labeled.length > 0 ? [{ title: sectionTitle(header), resources: labeled }] : []

    return { sections, notes }
  })

export { decodeDicom, sectionTitle }
