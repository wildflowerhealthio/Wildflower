/**
 * Decode one study — every picked `.dcm` of it — into one section of FHIR
 * resources and the notes that say what each file contributed.
 *
 * @packageDocumentation
 */
import type { DicomHeader } from 'dicom'
import { Effect, type ParseResult } from 'effect'
import { adoptResource } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { DecodedFile, PickedFile } from 'importer-fundamentals'

import {
  accessionNumbers,
  orderedInstances,
  patientOriginalId,
  toFhirResources,
} from './fhir/to-fhir.ts'
import type { StudyInstance } from './fhir/to-fhir.ts'
import type { DicomSettings } from './settings.ts'
import { DICOM_SYSTEM } from './source-system.ts'

const adopt = adoptResource({ system: DICOM_SYSTEM })

const labelAdopted = (resource: FhirResource, key: string, title: string): DecodedFile.Resource => {
  const adopted = adopt(resource)
  return { key, title, resource: adopted }
}

/** One picked file of a study: the pick, its parsed header, and its archive's id. */
interface StudyFile extends StudyInstance {
  readonly file: PickedFile.Type
}

/**
 * Build the section title from the study's representative header:
 * `<Modality> <StudyDescription> · <StudyDate>`, falling back to
 * `DICOM study` when nothing is available.
 */
const sectionTitle = (header: DicomHeader.Type): string => {
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

/** How one file reads in the notes: which series and instance of the study it is. */
const contributionNote = ({ file, header }: StudyFile): string =>
  `${file.fileName}: series ${header.seriesNumber ?? header.seriesInstanceUid}, instance ${header.instanceNumber ?? header.sopInstanceUid}.`

/** The notes a unit's headers earn, beyond the resources they synthesize. */
const studyNotes = (files: readonly StudyFile[]): readonly string[] => {
  const notes: string[] = []
  const accessions = accessionNumbers(files)
  if (accessions.length === 0) {
    notes.push('No AccessionNumber — no ServiceRequest will be created.')
  } else if (accessions.length > 1) {
    notes.push(
      `Files disagree on AccessionNumber (${accessions.join(', ')}) — the ServiceRequest uses ${accessions[0]}.`
    )
  }
  // A one-file study's contribution is its whole section; only a study spread
  // across files needs each file's place in it spelled out.
  if (files.length > 1) {
    for (const instance of orderedInstances(files)) notes.push(contributionNote(instance))
  }
  return notes
}

/**
 * Decode one study's picked files into a section of adopted, labeled FHIR
 * resources.
 *
 * @param files - Every picked `.dcm` of one study, each with its parsed header
 *   and the id of the `DocumentReference` storing its bytes — that id is what
 *   the file's `ImagingStudy` instance carries as its `gridfsFileId`
 *   extension, so each instance names the archive it was read from
 * @param settings - The import's settings; its `timeZone` is what
 *   `ImagingStudy.started` is resolved against
 * @returns One section when the study carries a patient, plus notes for what
 *   could not be extracted and what each file contributed; fails with a
 *   `ParseError` when a synthesized resource does not satisfy its schema
 *
 * @remarks
 * The resource keys are fixed — `patient`, `service-request`,
 * `imaging-study` — and are the same keys the per-file decode used before a
 * study spanned files, so a review's exclusions survive both a settings
 * re-decode and this change. They are unique only *within* one unit; the
 * decode function namespaces them by the unit's opening pick.
 *
 * The time zone is not checked here: it is one setting for the whole batch,
 * so `dicom-decode.ts` rejects a zone the runtime cannot resolve once, before
 * any unit is decoded, rather than per study.
 */
const decodeStudy = (
  files: readonly StudyFile[],
  settings: DicomSettings
): Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError> =>
  Effect.gen(function* () {
    const ordered = orderedInstances(files)
    const head = ordered[0]
    if (head === undefined) return { sections: [], notes: [] }

    if (patientOriginalId(head.header) === undefined) {
      return {
        sections: [],
        notes: ['No patient identity in the DICOM header (no PatientID or PatientName).'],
      }
    }

    const notes = studyNotes(files)
    const resources = yield* toFhirResources(files, settings)
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
      labeled.length > 0 ? [{ title: sectionTitle(head.header), resources: labeled }] : []

    return { sections, notes }
  })

export { decodeStudy, sectionTitle }
export type { StudyFile }
