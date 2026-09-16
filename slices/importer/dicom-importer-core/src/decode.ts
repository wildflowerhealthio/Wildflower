/**
 * Decode a DICOM file's raw bytes into one section of FHIR resources and
 * diagnostic notes — the descriptor's `decode`. A `dicom-parser` failure
 * is a `ParseError`.
 *
 * @packageDocumentation
 */
import type { DicomHeader } from 'dicom'
import { parseDicomFile } from 'dicom'
import { DateTime, Effect, Either, Option, ParseResult, Schema } from 'effect'
import { joinIdComponents, localResourceId, adoptResource } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import {
  sha256Base64,
  type DecodedFile,
  type LabeledResource,
  type LabeledSection,
} from 'importer-fundamentals'

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

/**
 * The id `buildSourceFile` (`source-file-codec.ts`) mints for this file's
 * `DocumentReference` — same digest, same name, same derivation — so the
 * `ImagingStudy` instance's `gridfsFileId` extension names the exact resource
 * the shell will also store.
 */
const sourceFileId = (
  fileBytes: Uint8Array,
  fileName: string
): Effect.Effect<string, ParseResult.ParseError> =>
  sha256Base64(new Uint8Array(fileBytes)).pipe(
    Effect.map((hash) =>
      localResourceId(DICOM_SYSTEM, 'DocumentReference', joinIdComponents([hash, fileName]))
    ),
    Effect.mapError((error) => dicomParseAsParseError(error.reason))
  )

const labelAdopted = (
  resource: FhirResource,
  key: string,
  title: string
): LabeledResource<FhirResource> => {
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
 * Decode a DICOM file's raw bytes into sections of adopted, labeled FHIR
 * resources.
 *
 * @param fileBytes - The raw bytes of a `.dcm` file
 * @param fileName - The picked file's name, used to derive the same
 *   deterministic `DocumentReference` id `buildSourceFile` mints, so the
 *   `ImagingStudy` instance can carry it as a `gridfsFileId` extension
 * @param settings - The import's settings; its `timeZone` is what every
 *   `ImagingStudy.started` is resolved against
 * @returns One section when the file carries at least a patient, plus notes
 *   for anything that could not be extracted; fails with a `ParseError` when
 *   the bytes cannot be parsed as DICOM, or when `settings.timeZone` is not an
 *   IANA time zone name
 */
const decodeDicom = (
  fileBytes: Uint8Array,
  fileName: string,
  settings: DicomSettings
): Effect.Effect<DecodedFile<FhirResource>, ParseResult.ParseError> =>
  Effect.gen(function* () {
    yield* checkTimeZone(settings.timeZone)

    const parseResult = parseDicomFile(fileBytes)
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

    const documentReferenceId = yield* sourceFileId(fileBytes, fileName)
    const resources = yield* toFhirResources(header, settings, documentReferenceId)
    const labeled: LabeledResource<FhirResource>[] = []

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

    const sections: LabeledSection<FhirResource>[] =
      labeled.length > 0 ? [{ title: sectionTitle(header), resources: labeled }] : []

    return { sections, notes }
  })

export { decodeDicom, sectionTitle }
