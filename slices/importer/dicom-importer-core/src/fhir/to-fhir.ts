import type { DicomHeader, PersonName } from 'dicom'
/**
 * Synthesize FHIR R4 resources from one study's parsed
 * {@link DicomHeader.Type}s: a `Patient`, optionally a `ServiceRequest` (when
 * any file states an `AccessionNumber`), and the one `ImagingStudy` whose
 * `series` are the study's distinct `SeriesInstanceUID`s and whose `instance`s
 * are its files.
 *
 * @remarks
 * The whole file set — every picked `.dcm` of one study — is the input,
 * because the counts, the modality set and the earliest `started` are facts
 * about the study and no single file states them. What makes a set of files
 * one study is `decode.ts`; what this module does with one is described on
 * {@link toFhirResources}.
 *
 * Ids are deterministic — the same tags produce the same ids — so re-importing
 * the same study overwrites rather than duplicates, and the order the files
 * were picked in changes nothing (see {@link compareInstances}). The
 * derivation mirrors `lifelabs-pdf-importer-core`'s wire-builder pattern: a
 * `sourceId` from `joinIdComponents` through `fnv1a64`, validated through the
 * `fhir-r4` schemas' `Schema.decodeUnknown`.
 *
 * @packageDocumentation
 */
import { Array as Arr, DateTime, Effect, Option, Order, type ParseResult, Schema } from 'effect'
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
 * the `DocumentReference` that stores that one DICOM file's raw bytes — the
 * link from each synthesized instance back to the file it was read from.
 *
 * @remarks
 * Per *instance*, which is why a study spanning many files keeps per-file
 * provenance that `meta.source` alone could not carry: `meta.source` names one
 * source file, and a study has as many source files as it has files.
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
 * A DICOM `PersonName.Type` as a FHIR `HumanName`. `text` is always non-empty —
 * the `dicom` parser returns `undefined` rather than an empty name — so this
 * never emits the `text: ''` FHIR `string` forbids.
 */
const humanNameWire = (pn: PersonName.Type): Wire => {
  const wire: Wire = { text: pn.text }
  if (pn.family !== '') wire['family'] = pn.family
  if (pn.given !== '') wire['given'] = pn.given.split(/\s+/).filter((p) => p.length > 0)
  return wire
}

// ---------------------------------------------------------------------------
// Patient
// ---------------------------------------------------------------------------

const patientOriginalId = (header: DicomHeader.Type): string | undefined => {
  if (header.patientId !== undefined && header.patientId !== '') {
    const issuer = header.issuerOfPatientId ?? DICOM_SYSTEM
    return sourceId(['patient-id', issuer, header.patientId])
  }
  if (header.patientName !== undefined) {
    return sourceId(['patient-name', header.patientName.text, header.patientBirthDate ?? ''])
  }
  return undefined
}

const patientWire = (header: DicomHeader.Type): Wire | undefined => {
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

const serviceRequestOriginalId = (header: DicomHeader.Type): string =>
  sourceId(['accession', header.accessionNumber!])

const serviceRequestWire = (header: DicomHeader.Type, patientId: string): Wire | undefined => {
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
// ImagingStudy — one per study, its series and instances the study's files
// ---------------------------------------------------------------------------

/**
 * One file of a study, as the synthesis sees it: its parsed header and the id
 * of the `DocumentReference` storing its bytes.
 *
 * @remarks
 * The whole file set, not one file, is what {@link toFhirResources} takes: a
 * study is one `ImagingStudy` whose `series` and `instance`s are spread across
 * the picked files, and no single file can state the counts, the modality set, or
 * the earliest `started`.
 */
interface StudyInstance {
  /** The file's parsed DICOM header. */
  readonly header: DicomHeader.Type
  /**
   * The id of the `DocumentReference` storing this file's raw bytes, when
   * known — stamped onto this instance as its `gridfsFileId` extension, so
   * every instance names its own source file rather than the study naming one.
   */
  readonly sourceFileId?: string | undefined
}

/**
 * One series of a study: its instances, in `InstanceNumber` order.
 *
 * @typeParam T - What the caller carries per instance. The grouping reads only
 *   {@link StudyInstance}, so a caller that tracks more — the picked file each
 *   instance came from, as the decode does — gets its own rows back rather
 *   than having to re-associate them by UID.
 */
interface StudySeries<T extends StudyInstance = StudyInstance> {
  readonly uid: string
  /** The instances of this series, ordered. Never empty. */
  readonly instances: readonly T[]
}

const imagingStudyOriginalId = (header: DicomHeader.Type): string =>
  sourceId(['study', header.studyInstanceUid])

/**
 * Where an absent `SeriesNumber` / `InstanceNumber` sorts: after every stated
 * one, rather than before, so a numbered series keeps its position when a file
 * carrying no number joins the study.
 */
const UNNUMBERED = Number.MAX_SAFE_INTEGER

/** Compare two strings by code unit — `localeCompare` is locale-dependent, this is not. */
const compareText = (left: string, right: string): number => {
  if (left < right) return -1
  return left > right ? 1 : 0
}

/**
 * Order two instances within their series: by `InstanceNumber`, then by
 * `SOPInstanceUID`, then by the source file they came from.
 *
 * @remarks
 * Total, and a function of the files alone — no tie is broken by pick order.
 * That is what makes the whole synthesis idempotent: the same study picked in
 * any file order yields the same resources, byte for byte, so a re-import
 * overwrites rather than reshuffling. The last tiebreak matters for the one
 * case the first two do not separate — two files carrying the same
 * `SOPInstanceUID`, which a study spanning two folders can produce.
 */
const compareInstances = (left: StudyInstance, right: StudyInstance): number =>
  (left.header.instanceNumber ?? UNNUMBERED) - (right.header.instanceNumber ?? UNNUMBERED) ||
  compareText(left.header.sopInstanceUid, right.header.sopInstanceUid) ||
  compareText(left.sourceFileId ?? '', right.sourceFileId ?? '')

/** Order two series within their study: by `SeriesNumber`, then by `SeriesInstanceUID`. */
const compareSeries = (left: StudySeries, right: StudySeries): number => {
  const leftHead = left.instances[0].header
  const rightHead = right.instances[0].header
  return (
    (leftHead.seriesNumber ?? UNNUMBERED) - (rightHead.seriesNumber ?? UNNUMBERED) ||
    compareText(left.uid, right.uid)
  )
}

/** A `compare`'s sign, as `Order.make` spells a comparison. */
const sign = (comparison: number): -1 | 0 | 1 => {
  if (comparison < 0) return -1
  return comparison > 0 ? 1 : 0
}

const instanceOrder: Order.Order<StudyInstance> = Order.make((left, right) =>
  sign(compareInstances(left, right))
)

const seriesOrder: Order.Order<StudySeries> = Order.make((left, right) =>
  sign(compareSeries(left, right))
)

/**
 * Group a study's instances into its series, both levels ordered.
 *
 * @param instances - Every file of one study, in any order
 * @returns The study's series by `SeriesInstanceUID`, ordered by
 *   `SeriesNumber`, each carrying its instances ordered by `InstanceNumber`
 */
const studySeries = <T extends StudyInstance>(instances: readonly T[]): readonly StudySeries<T>[] =>
  Arr.sort(
    Object.entries(Arr.groupBy(instances, (instance) => instance.header.seriesInstanceUid)).map(
      ([uid, members]): StudySeries<T> => ({ uid, instances: Arr.sort(members, instanceOrder) })
    ),
    seriesOrder
  )

/**
 * The study's instances in study order — every series' instances, series by
 * series. The first of them is the study's representative: the header the
 * `Patient` and the section title are read off, and the source file the
 * study-level resources' `meta.source` names.
 */
const orderedInstances = <T extends StudyInstance>(instances: readonly T[]): readonly T[] =>
  studySeries(instances).flatMap((series) => series.instances)

/**
 * How a header's acquisition instant sorts, as one comparable string.
 *
 * @remarks
 * `DA` is fixed-width `YYYYMMDD` and `TM` is `HHMMSS.FFFFFF` truncated at any
 * component boundary (PS3.5 6.2), so padding the time to full width makes
 * lexicographic order chronological order — an hour-only `14` sorts before
 * `1430`, as it must. A header with no `StudyDate` sorts last rather than
 * claiming the earliest instant.
 */
const startRank = (header: DicomHeader.Type): Option.Option<string> =>
  Option.map(
    Option.fromNullable(header.studyDate),
    (studyDate) => `${studyDate}${(header.studyTime ?? '').padEnd(13, '0')}`
  )

/**
 * Order two instances by acquisition instant, a header stating none last.
 *
 * @remarks
 * `Option.getOrder` sorts `None` *first*, which would let a file with no
 * `StudyDate` claim the study's `started`; reversing it around a reversed
 * string order puts `None` last while keeping the stated instants ascending.
 */
const startedOrder: Order.Order<StudyInstance> = Order.mapInput(
  Order.reverse(Option.getOrder(Order.reverse(Order.string))),
  (instance: StudyInstance) => startRank(instance.header)
)

/** The earliest-acquired header of a study — the one `started` is read from. */
const earliestStarted = (instances: readonly StudyInstance[]): Option.Option<DicomHeader.Type> =>
  Arr.isNonEmptyReadonlyArray(instances)
    ? Option.some(Arr.min(instances, startedOrder).header)
    : Option.none()

/** The distinct `AccessionNumber`s a study's files state, in study order. */
const accessionNumbers = (instances: readonly StudyInstance[]): readonly string[] =>
  Arr.dedupe(
    Arr.filterMap(orderedInstances(instances), (instance) =>
      Option.filter(
        Option.fromNullable(instance.header.accessionNumber),
        (accession) => accession !== ''
      )
    )
  )

/** One instance of a series, as `ImagingStudy.series.instance` carries it. */
const instanceWire = ({ header, sourceFileId }: StudyInstance): Wire => {
  const wire: Wire = {
    uid: header.sopInstanceUid,
    sopClass: {
      system: DICOM_UID_SYSTEM,
      code: header.sopClassUid,
    },
  }
  if (header.instanceNumber !== undefined) wire['number'] = header.instanceNumber
  if (sourceFileId !== undefined) {
    wire['extension'] = [{ url: GRIDFS_FILE_ID_EXTENSION_URL, valueString: sourceFileId }]
  }
  return wire
}

/**
 * One series, as `ImagingStudy.series` carries it. Its describing attributes
 * come from its first instance — a series' `Modality`, `SeriesDescription` and
 * `BodyPartExamined` are series-level tags repeated on every file of it, so
 * reading them off the first is reading the series' own.
 */
const seriesWire = (series: StudySeries): Wire => {
  const head = series.instances[0].header
  const wire: Wire = {
    uid: series.uid,
    modality: { system: DCM_CODING_SYSTEM, code: head.modality },
    numberOfInstances: series.instances.length,
    instance: series.instances.map(instanceWire),
  }
  if (head.seriesNumber !== undefined) wire['number'] = head.seriesNumber
  if (head.seriesDescription !== undefined) wire['description'] = head.seriesDescription
  if (head.bodyPartExamined !== undefined) wire['bodySite'] = { display: head.bodyPartExamined }
  return wire
}

const imagingStudyWire = (
  instances: readonly StudyInstance[],
  patientId: string,
  serviceRequestId: string | undefined,
  timeZone: string
): Wire => {
  const series = studySeries(instances)
  const head = series[0].instances[0].header
  const id = imagingStudyOriginalId(head)

  const wire: Wire = {
    resourceType: 'ImagingStudy',
    id,
    status: 'available',
    subject: { reference: `Patient/${patientId}` },
    identifier: [
      {
        system: DICOM_UID_SYSTEM,
        value: `urn:oid:${head.studyInstanceUid}`,
      },
    ],
    numberOfSeries: series.length,
    numberOfInstances: instances.length,
    series: series.map(seriesWire),
  }

  const started = Option.flatMapNullable(earliestStarted(instances), (header) =>
    fhirDateTime(header.studyDate, header.studyTime, timeZone)
  )
  if (Option.isSome(started)) wire['started'] = started.value

  // Every modality the study's series carry, in series order — a study whose
  // files disagree is a PET/CT, not a conflict.
  const modalities = Arr.dedupe(series.map((one) => one.instances[0].header.modality))
  wire['modality'] = modalities.map((code) => ({ system: DCM_CODING_SYSTEM, code }))

  const described = Arr.findFirst(
    orderedInstances(instances),
    (instance) => instance.header.studyDescription !== undefined
  )
  if (Option.isSome(described)) wire['description'] = described.value.header.studyDescription

  if (serviceRequestId !== undefined) {
    wire['basedOn'] = [{ reference: `ServiceRequest/${serviceRequestId}` }]
  }

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
 * Synthesize FHIR resources from one study's files.
 *
 * @param instances - Every picked file of one study — same `StudyInstanceUID`,
 *   same patient — in any order, each with the id of the source file storing it
 * @param settings - The import's settings; its `timeZone` is what
 *   `ImagingStudy.started` is resolved against (see `dates.ts`)
 * @returns The resources in write order: Patient first (when the headers carry
 *   a patient identity), then ServiceRequest (when any file states an
 *   `AccessionNumber`), then the one ImagingStudy. Fails with a `ParseError`
 *   when a wire object does not satisfy its schema.
 *
 * @remarks
 * The study's *representative* header — the first instance of the first series,
 * not the first picked file — is what the `Patient` and the study's
 * describing attributes are read from, and the accession the `ServiceRequest`
 * is built from is the first stated in that same order. Every choice this
 * makes is a function of the files alone (see {@link compareInstances}), so the
 * same study picked in any order, or re-picked file by file, synthesizes
 * identical resources under identical ids.
 *
 * Files that disagree on `AccessionNumber` are *not* merged into one request:
 * the first is used and {@link accessionNumbers} is what a caller reports the
 * disagreement from. Files that disagree on the patient never reach here — a
 * differing `PatientID` splits the file set upstream.
 */
const toFhirResources = (
  instances: readonly StudyInstance[],
  settings: DicomSettings
): Effect.Effect<readonly DicomFhirResources[], ParseResult.ParseError> =>
  Effect.gen(function* () {
    const resources: DicomFhirResources[] = []
    const ordered = orderedInstances(instances)
    const head = ordered[0]
    if (head === undefined) return resources

    const patientId = patientOriginalId(head.header)
    if (patientId === undefined) return resources

    const patientWireObj = patientWire(head.header)
    if (patientWireObj !== undefined) {
      resources.push(yield* decodePatient(patientWireObj))
    }

    // The accession the request is built from: the first stated in study
    // order, which is the same one for any pick order of the same files.
    const [accessionNumber] = accessionNumbers(instances)
    let serviceRequestId: string | undefined
    if (accessionNumber !== undefined) {
      const requestHeader = { ...head.header, accessionNumber }
      const srWire = serviceRequestWire(requestHeader, patientId)
      if (srWire !== undefined) {
        serviceRequestId = serviceRequestOriginalId(requestHeader)
        resources.push(yield* decodeServiceRequest(srWire))
      }
    }

    resources.push(
      yield* decodeImagingStudy(
        imagingStudyWire(instances, patientId, serviceRequestId, settings.timeZone)
      )
    )

    return resources
  })

export {
  accessionNumbers,
  fhirDate,
  fhirDateTime,
  imagingStudyOriginalId,
  orderedInstances,
  patientOriginalId,
  serviceRequestOriginalId,
  studySeries,
  toFhirResources,
}
export type { StudyInstance, StudySeries }
