import type { DicomHeader } from 'dicom'
import { parseDicomFile } from 'dicom'
/**
 * Decode a DICOM file's raw bytes into one section of FHIR resources and
 * diagnostic notes — the descriptor's `decode`.
 *
 * @remarks
 * Parses the DICOM tags via the `dicom` file-formats package, synthesizes
 * Patient / ServiceRequest / ImagingStudy via `to-fhir.ts`, and adopts them
 * under `DICOM_SYSTEM`. A `dicom-parser` failure is a `ParseError`, not a
 * throw. One section per file, titled `<Modality> <StudyDescription> ·
 * <StudyDate>`, with stable keys `patient`, `service-request`,
 * `imaging-study`.
 *
 * @packageDocumentation
 */
import { Effect, Either, ParseResult, Schema } from 'effect'
import { adoptResource } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { DecodedFile, LabeledResource, LabeledSection } from 'importer-fundamentals'

import { toFhirResources, patientOriginalId } from './fhir/to-fhir.ts'
import type { DicomSettings } from './settings.ts'
import { DICOM_SYSTEM } from './source-system.ts'

const adopt = adoptResource({ system: DICOM_SYSTEM })

const dicomParseAsParseError = (reason: string): ParseResult.ParseError =>
  new ParseResult.ParseError({
    issue: new ParseResult.Forbidden(Schema.Unknown.ast, undefined, reason),
  })

const labelAdopted = (
  resource: FhirResource,
  key: string,
  title: string
): LabeledResource<FhirResource> => {
  const adopted = adopt(resource)
  return { key, title, resource: adopted }
}

/**
 * Build the section title from the header: `<Modality> <StudyDescription> ·
 * <StudyDate>`, falling back to `DICOM study` when nothing is available.
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
 * @param _settings - The import's settings (currently unused)
 * @returns One section when the file carries at least a patient, plus notes
 *   for anything that could not be extracted; fails with a `ParseError` when
 *   the bytes cannot be parsed as DICOM
 */
const decodeDicom = (
  fileBytes: Uint8Array,
  _settings: DicomSettings
): Effect.Effect<DecodedFile<FhirResource>, ParseResult.ParseError> =>
  Effect.gen(function* () {
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

    const resources = yield* toFhirResources(header)
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
