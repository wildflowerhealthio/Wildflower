import type { DicomHeader, PersonName } from 'dicom'
/**
 * Synthesize FHIR R4 resources from a parsed {@link DicomHeader}: a `Patient`,
 * optionally a `ServiceRequest` (when `AccessionNumber` is present), and an
 * `ImagingStudy` with one series carrying one instance.
 *
 * @remarks
 * Ids are deterministic — the same tags produce the same ids — so re-importing
 * the same DICOM file overwrites rather than duplicates. The derivation mirrors
 * `lifelabs-pdf-importer-core`'s wire-builder pattern: a `sourceId` from
 * `joinIdComponents` through `fnv1a64`, validated through the `fhir-r4`
 * schemas' `Schema.decodeUnknown`.
 *
 * @packageDocumentation
 */
import { DateTime, Effect, Option, type ParseResult, Schema } from 'effect'
import { joinIdComponents } from 'fhir-r4/identity'
import { ImagingStudy, Patient, ServiceRequest } from 'fhir-r4/resources'
import { fnv1a64 } from 'kitchen-sink'

import type { DicomSettings } from '../settings.ts'
import { DICOM_SYSTEM } from '../source-system.ts'
import { dicomCalendarDate, dicomInstant } from './dates.ts'

type Wire = Record<string, unknown>

const sourceId = (components: readonly string[]): string =>
  fnv1a64(joinIdComponents(components)).toString(16).padStart(16, '0')

const DCM_CODING_SYSTEM = 'http://dicom.nema.org/resources/ontology/DCM'
const DICOM_UID_SYSTEM = 'urn:dicom:uid'

/**
 * The extension URL stamped on an `ImagingStudy` instance, carrying the id of
 * the `DocumentReference` that stores this DICOM file's raw bytes — the link
 * from the synthesized instance back to its source file.
 */
const GRIDFS_FILE_ID_EXTENSION_URL = 'gridfsFileId'

const genderOf = (sex: string | undefined): string | undefined => {
  if (sex === undefined) return undefined
  switch (sex.trim().toUpperCase()) {
    case 'M':
      return 'male'
    case 'F':
      return 'female'
    case 'O':
      return 'other'
    default:
      return undefined
  }
}

/**
 * Format a DICOM `DA` date (`YYYYMMDD`) as a FHIR `date` (`YYYY-MM-DD`).
 * Returns `undefined` for a missing, malformed, or impossible date.
 */
const fhirDate = (da: string | undefined): string | undefined =>
  Option.getOrUndefined(dicomCalendarDate(da))

/**
 * Compose a FHIR `dateTime` from a DICOM `DA` date and optional `TM` time.
 *
 * @param da - The `DA` value (`20240315`)
 * @param tm - The `TM` value (`143022`), when the header carries one
 * @param timeZone - The IANA zone the equipment's clock was set to
 * @returns The instant as an offset-bearing `dateTime` when a time is present
 *   (`2024-03-15T18:30:22.000Z`), the bare calendar date when it is not, or
 *   `undefined` when there is no usable date
 *
 * @remarks
 * A `DA` with no usable `TM` stays a bare date, which `dateTime` permits with
 * no offset; a midnight would invent a time of day the file never stated. See
 * `dates.ts` for why the zone is needed at all.
 */
const fhirDateTime = (
  da: string | undefined,
  tm: string | undefined,
  timeZone: string
): string | undefined => {
  const instant = dicomInstant(da, tm, timeZone)
  if (Option.isSome(instant)) return DateTime.formatIso(instant.value)
  return fhirDate(da)
}

/**
 * A DICOM `PersonName` as a FHIR `HumanName`. `text` is always non-empty — the
 * `dicom` parser returns `undefined` rather than an empty name — so this never
 * emits the `text: ''` FHIR `string` forbids.
 */
const humanNameWire = (pn: PersonName): Wire => {
  const wire: Wire = { text: pn.text }
  if (pn.family !== '') wire['family'] = pn.family
  if (pn.given !== '') wire['given'] = pn.given.split(/\s+/).filter((p) => p.length > 0)
  return wire
}

// ---------------------------------------------------------------------------
// Patient
// ---------------------------------------------------------------------------

const patientOriginalId = (header: DicomHeader): string | undefined => {
  if (header.patientId !== undefined && header.patientId !== '') {
    const issuer = header.issuerOfPatientId ?? DICOM_SYSTEM
    return sourceId(['patient-id', issuer, header.patientId])
  }
  if (header.patientName !== undefined) {
    return sourceId(['patient-name', header.patientName.text, header.patientBirthDate ?? ''])
  }
  return undefined
}

const patientWire = (header: DicomHeader): Wire | undefined => {
  const id = patientOriginalId(header)
  if (id === undefined) return undefined

  const wire: Wire = { resourceType: 'Patient', id }

  const identifier: Wire[] = []
  if (header.patientId !== undefined && header.patientId !== '') {
    const patIdentifier: Wire = {
      system: DICOM_SYSTEM,
      value: header.patientId,
    }
    if (header.issuerOfPatientId !== undefined && header.issuerOfPatientId !== '') {
      patIdentifier['assigner'] = { display: header.issuerOfPatientId }
    }
    identifier.push(patIdentifier)
  }
  if (identifier.length > 0) wire['identifier'] = identifier

  if (header.patientName !== undefined) wire['name'] = [humanNameWire(header.patientName)]

  const gender = genderOf(header.patientSex)
  if (gender !== undefined) wire['gender'] = gender

  const birthDate = fhirDate(header.patientBirthDate)
  if (birthDate !== undefined) wire['birthDate'] = birthDate

  return wire
}

// ---------------------------------------------------------------------------
// ServiceRequest — emitted only when AccessionNumber is present
// ---------------------------------------------------------------------------

const serviceRequestOriginalId = (header: DicomHeader): string =>
  sourceId(['accession', header.accessionNumber!])

const serviceRequestWire = (header: DicomHeader, patientId: string): Wire | undefined => {
  if (header.accessionNumber === undefined || header.accessionNumber === '') return undefined

  const id = serviceRequestOriginalId(header)
  const wire: Wire = {
    resourceType: 'ServiceRequest',
    id,
    status: 'completed',
    intent: 'order',
    subject: { reference: `Patient/${patientId}` },
    identifier: [{ system: DICOM_SYSTEM, value: header.accessionNumber }],
  }

  const description = header.requestedProcedureDescription ?? header.studyDescription
  if (description !== undefined && description !== '') {
    wire['code'] = { text: description }
  }

  if (header.referringPhysicianName !== undefined) {
    wire['requester'] = { display: header.referringPhysicianName.text }
  }

  return wire
}

// ---------------------------------------------------------------------------
// ImagingStudy
// ---------------------------------------------------------------------------

const imagingStudyOriginalId = (header: DicomHeader): string =>
  sourceId(['study', header.studyInstanceUid])

const imagingStudyWire = (
  header: DicomHeader,
  patientId: string,
  serviceRequestId: string | undefined,
  sourceFileId: string | undefined,
  timeZone: string
): Wire => {
  const id = imagingStudyOriginalId(header)

  const wire: Wire = {
    resourceType: 'ImagingStudy',
    id,
    status: 'available',
    subject: { reference: `Patient/${patientId}` },
    identifier: [
      {
        system: DICOM_UID_SYSTEM,
        value: `urn:oid:${header.studyInstanceUid}`,
      },
    ],
    numberOfSeries: 1,
    numberOfInstances: 1,
  }

  const started = fhirDateTime(header.studyDate, header.studyTime, timeZone)
  if (started !== undefined) wire['started'] = started

  if (header.modality !== undefined) {
    wire['modality'] = [{ system: DCM_CODING_SYSTEM, code: header.modality }]
  }

  if (header.studyDescription !== undefined) wire['description'] = header.studyDescription

  if (serviceRequestId !== undefined) {
    wire['basedOn'] = [{ reference: `ServiceRequest/${serviceRequestId}` }]
  }

  // One series with one instance
  const instance: Wire = {
    uid: header.sopInstanceUid,
    sopClass: {
      system: DICOM_UID_SYSTEM,
      code: header.sopClassUid ?? '1.2.840.10008.5.1.4.1.1.7',
    },
  }
  if (header.instanceNumber !== undefined) instance['number'] = header.instanceNumber
  if (sourceFileId !== undefined) {
    instance['extension'] = [{ url: GRIDFS_FILE_ID_EXTENSION_URL, valueString: sourceFileId }]
  }

  const modalityCode = header.modality ?? 'OT'

  const series: Wire = {
    uid: header.seriesInstanceUid,
    modality: { system: DCM_CODING_SYSTEM, code: modalityCode },
    instance: [instance],
  }
  if (header.seriesNumber !== undefined) series['number'] = header.seriesNumber
  if (header.seriesDescription !== undefined) series['description'] = header.seriesDescription
  if (header.bodyPartExamined !== undefined) {
    series['bodySite'] = { display: header.bodyPartExamined }
  }

  wire['series'] = [series]

  return wire
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const decodePatient = Schema.decodeUnknown(Patient.Schema)
const decodeServiceRequest = Schema.decodeUnknown(ServiceRequest.Schema)
const decodeImagingStudy = Schema.decodeUnknown(ImagingStudy.Schema)

type DicomFhirResources =
  | typeof Patient.Schema.Type
  | typeof ServiceRequest.Schema.Type
  | typeof ImagingStudy.Schema.Type
/**
 * Synthesize FHIR resources from a parsed DICOM header.
 *
 * @param header - The parsed DICOM tags
 * @param settings - The import's settings; its `timeZone` is what
 *   `ImagingStudy.started` is resolved against (see `dates.ts`)
 * @param sourceFileId - The id of the `DocumentReference` storing this DICOM
 *   file's raw bytes, when known — stamped onto the `ImagingStudy` instance
 *   as a `gridfsFileId` extension so the instance can be traced back to its
 *   source file
 * @returns The resources in write order: Patient first (when present), then
 *   ServiceRequest (when AccessionNumber is present), then ImagingStudy.
 *   Fails with a `ParseError` when a wire object does not satisfy its schema.
 */
const toFhirResources = (
  header: DicomHeader,
  settings: DicomSettings,
  sourceFileId?: string
): Effect.Effect<readonly DicomFhirResources[], ParseResult.ParseError> =>
  Effect.gen(function* () {
    const resources: DicomFhirResources[] = []
    const patientId = patientOriginalId(header)
    if (patientId === undefined) return resources

    const patientWireObj = patientWire(header)

    if (patientWireObj !== undefined) {
      resources.push(yield* decodePatient(patientWireObj))
    }

    let serviceRequestId: string | undefined
    const srWire = serviceRequestWire(header, patientId)
    if (srWire !== undefined) {
      serviceRequestId = serviceRequestOriginalId(header)
      resources.push(yield* decodeServiceRequest(srWire))
    }

    resources.push(
      yield* decodeImagingStudy(
        imagingStudyWire(header, patientId, serviceRequestId, sourceFileId, settings.timeZone)
      )
    )

    return resources
  })

export {
  fhirDate,
  fhirDateTime,
  imagingStudyOriginalId,
  patientOriginalId,
  serviceRequestOriginalId,
  toFhirResources,
}
