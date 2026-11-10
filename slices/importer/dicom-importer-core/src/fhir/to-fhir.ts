import type { DicomHeader, PersonName } from '@wildflowerhealthio/dicom'
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
 * Every record is written detached: keyed (`identifier[0]`) by the identifier
 * the file itself carries for it, naming the others by logical reference — a
 * Patient by its Patient ID under its issuer, a ServiceRequest by its
 * Accession Number under its issuer, an ImagingStudy by its Study Instance
 * UID, as FHIR R4's own DICOM mapping for `ImagingStudy.identifier` reads
 * them. The same study picked twice, or from two discs, keys the same
 * records, and the order the files were picked in changes nothing (see
 * {@link compareInstances}). Each wire is validated through
 * `fhir-r4-adoption`'s `DetachedResource.decodeUnknown`.
 *
 * @packageDocumentation
 */
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { HumanName, type IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  ImagingStudy,
  Patient,
  Practitioner,
  ServiceRequest,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  Array as Arr,
  DateTime,
  Effect,
  Option,
  Order,
  type ParseResult,
  String as Str,
} from 'effect'

import type { DicomSettings } from '../settings.ts'
import { DICOM_PRACTITIONER_NAME_SYSTEM, DicomIdentifierSystem } from '../source-system.ts'
import { dicomCalendarDate, dicomInstant } from './dates.ts'
import { issuedIdentifierOf, issuedIdentifierWire, type IssuedIdentifier } from './issuer.ts'

type Wire = Record<string, unknown>

const DCM_CODING_SYSTEM = 'http://dicom.nema.org/resources/ontology/DCM'

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

/** A PN's given names, one per word, as `HumanName.given` holds them. */
const givenNamesOf = (pn: PersonName.Type): readonly string[] =>
  Arr.filter(Str.split(pn.given, /\s+/), Str.isNonEmpty)

/**
 * A DICOM `PersonName.Type` as a FHIR `HumanName`. `text` is always non-empty —
 * the `dicom` parser returns `undefined` rather than an empty name — so this
 * never emits the `text: ''` FHIR `string` forbids.
 */
const humanNameWire = (pn: PersonName.Type): Wire => {
  const wire: Wire = { text: pn.text }
  if (pn.family !== '') wire['family'] = pn.family
  if (pn.given !== '') wire['given'] = givenNamesOf(pn)
  return wire
}

/**
 * A PN in the order a prescription or a report prints a name: the given names,
 * then the family name ("Smith^Jane" is "Jane Smith"), as `HumanName.displayName`
 * renders a name without `text`; empty when the PN has neither.
 *
 * @remarks
 * The PN `text` prints the family name first, so a name matched against
 * other sources is built from the parsed parts instead, by the same rule the
 * identity map renders a `Practitioner`'s name by. The parser keeps only the
 * family and given components apart, so the middle name, prefix and suffix the
 * `text` carries are left out.
 */
const naturalOrderName = (pn: PersonName.Type): string =>
  HumanName.displayName([{ family: pn.family, given: givenNamesOf(pn) }]) ?? ''

// ---------------------------------------------------------------------------
// Patient
// ---------------------------------------------------------------------------

/**
 * The identifier a header gives its patient: the Patient ID under its issuer,
 * else the Patient Name and birth date, else `None` — a patient the header
 * does not name at all, whom no `subject` could reference.
 *
 * @remarks
 * The issuer is Issuer of Patient ID Qualifiers Sequence (0010,0024)'s
 * Universal Entity ID; Issuer of Patient ID (0010,0021) is its local
 * namespace, displayed as the assigner. A patient named only by name is keyed
 * `<name>, <YYYY-MM-DD>` in `DicomIdentifierSystem.PatientNameBirthDate`, the
 * name alone when the header states no valid birth date, as LifeLabs keys a
 * report that prints no number.
 */
const patientIdentifierOf = (header: DicomHeader.Type): Option.Option<IssuedIdentifier> => {
  if (header.patientId !== undefined) {
    return Option.some(
      issuedIdentifierOf(
        header.patientId,
        {
          localNamespaceEntityId: header.issuerOfPatientId,
          universalEntityId: header.issuerOfPatientIdQualifiers?.universalEntityId,
          universalEntityIdType: header.issuerOfPatientIdQualifiers?.universalEntityIdType,
        },
        DicomIdentifierSystem.PatientId
      )
    )
  }
  return Option.map(Option.fromNullable(header.patientName), (name) => ({
    key: {
      system: DicomIdentifierSystem.PatientNameBirthDate,
      value: Option.match(dicomCalendarDate(header.patientBirthDate), {
        onNone: () => name.text,
        onSome: (birthDate) => `${name.text}, ${birthDate}`,
      }),
    },
    assignerDisplay: Option.none(),
    unresolvedIssuer: Option.none(),
  }))
}

/** The key a header's `Patient` is stored under, `None` when the header names no patient. */
const patientKeyOf = (header: DicomHeader.Type): Option.Option<DetachedResource.Key> =>
  Option.map(patientIdentifierOf(header), (identifier) => identifier.key)

const patientWire = (header: DicomHeader.Type, identifier: IssuedIdentifier): Wire => {
  const wire: Wire = { resourceType: 'Patient', identifier: [issuedIdentifierWire(identifier)] }

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

/** HL7 v2 table 0203's code for an accession number, the `type` FHIR's DICOM mapping gives one. */
const ACCESSION_IDENTIFIER_TYPE = {
  coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'ACSN' }],
}

/**
 * The identifier a file gives the order it was acquired for: its Accession
 * Number under the issuer Issuer of Accession Number Sequence (0008,0051)
 * states, the sequence's Local Namespace Entity ID displayed as the assigner.
 *
 * @remarks
 * The accession is the order's identity, so two patients' files stating one
 * Accession Number under one issuer are one `ServiceRequest`.
 */
const accessionIdentifierOf = (
  accessionNumber: string,
  header: DicomHeader.Type
): IssuedIdentifier =>
  issuedIdentifierOf(
    accessionNumber,
    header.issuerOfAccessionNumber,
    DicomIdentifierSystem.AccessionNumber
  )

/**
 * The `requester` wire for the referring physician, whom a DICOM header names
 * only by `ReferringPhysicianName`: `fhir-r4`'s `Practitioner.tryReferenceWireFromName`
 * of the {@link naturalOrderName} in `DICOM_PRACTITIONER_NAME_SYSTEM`, so the
 * import stage implies one Practitioner for every study that names them.
 * `None` when the PN has neither a given nor a family name.
 */
const requesterWire = (
  referringPhysician: PersonName.Type
): Option.Option<typeof IdentifierAndReference.ReferenceSchema.Encoded> =>
  Practitioner.tryReferenceWireFromName(
    DICOM_PRACTITIONER_NAME_SYSTEM,
    naturalOrderName(referringPhysician)
  )

const serviceRequestWire = (
  header: DicomHeader.Type,
  accession: IssuedIdentifier,
  patientKey: DetachedResource.Key
): Wire => {
  const wire: Wire = {
    resourceType: 'ServiceRequest',
    status: 'completed',
    intent: 'order',
    subject: DetachedResource.logicalReferenceWire('Patient', patientKey),
    identifier: [{ ...issuedIdentifierWire(accession), type: ACCESSION_IDENTIFIER_TYPE }],
  }

  const description = header.requestedProcedureDescription ?? header.studyDescription
  if (description !== undefined && description !== '') {
    wire['code'] = { text: description }
  }

  const requester = Option.flatMap(
    Option.fromNullable(header.referringPhysicianName),
    requesterWire
  )
  if (Option.isSome(requester)) wire['requester'] = requester.value

  return wire
}

// ---------------------------------------------------------------------------
// ImagingStudy — one per study, its series and instances the study's files
// ---------------------------------------------------------------------------

/**
 * One file of a study, as the synthesis sees it: its parsed header and the id
 * the decode knows the file by.
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

/**
 * The key a study's `ImagingStudy` is stored under: its Study Instance UID as
 * FHIR spells a DICOM UID, `urn:oid:<uid>` in `urn:dicom:uid`.
 *
 * @remarks
 * The UID alone, so two patients' files stating one UID key one
 * `ImagingStudy` (accepted); `studyKey` still decodes them as two sets.
 */
const imagingStudyKeyOf = (header: DicomHeader.Type): DetachedResource.Key => ({
  system: DicomIdentifierSystem.Uid,
  value: `urn:oid:${header.studyInstanceUid}`,
})

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
 * `SOPInstanceUID`, then by `SOPClassUID`.
 *
 * @remarks
 * A function of the headers alone, which is what makes the import idempotent:
 * the same study picked in any file order imports to the same resources, byte
 * for byte, so a re-import overwrites rather than reshuffling. The last
 * tiebreak matters for two files carrying the same `SOPInstanceUID`, which a
 * study spanning two folders can produce; two instances it leaves tied agree
 * on every field an instance is synthesized from, so their order shows in
 * nothing written.
 */
const compareInstances = (left: StudyInstance, right: StudyInstance): number =>
  (left.header.instanceNumber ?? UNNUMBERED) - (right.header.instanceNumber ?? UNNUMBERED) ||
  compareText(left.header.sopInstanceUid, right.header.sopInstanceUid) ||
  compareText(left.header.sopClassUid, right.header.sopClassUid)

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
 * `Patient` and the section title are read off.
 */
const orderedInstances = <T extends StudyInstance>(instances: readonly T[]): readonly T[] =>
  studySeries(instances).flatMap((series) => series.instances)

/**
 * How a header's acquisition instant sorts, as one comparable string of
 * digits.
 *
 * @remarks
 * `DA` is fixed-width `YYYYMMDD` once the retired `YYYY.MM.DD` spelling's dots
 * are dropped, and `TM` is `HHMMSS.FFFFFF` truncated at any component boundary
 * (PS3.5 6.2). Padding the clock and the fraction each to full width, with the
 * `.` between them dropped, makes lexicographic order chronological order — an
 * hour-only `14` sorts before `1430`, and `143022` before `143022.5`, as they
 * must; a `.` left in would sort below every digit. A header with no
 * `StudyDate` sorts last rather than claiming the earliest instant.
 */
const startRank = (header: DicomHeader.Type): Option.Option<string> =>
  Option.map(Option.fromNullable(header.studyDate), (studyDate) => {
    const [clock = '', fraction = ''] = (header.studyTime ?? '').split('.')
    return `${studyDate.replaceAll('.', '')}${clock.padEnd(6, '0')}${fraction.padEnd(6, '0')}`
  })

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

/**
 * The identifiers a study's records are keyed by, read off its files in study
 * order — the one place the synthesis and the decode's notes choose them.
 */
interface StudyIdentifiers {
  /** The `Patient`'s, off the representative header; `None` when it names no patient. */
  readonly patient: Option.Option<IssuedIdentifier>
  /**
   * Each distinct Accession Number under its issuer, in study order: the
   * first is the `ServiceRequest`'s, and more than one is a disagreement —
   * the same number under two issuers included.
   */
  readonly accessions: readonly IssuedIdentifier[]
}

/** The {@link StudyIdentifiers} of a study's files, given in study order ({@link orderedInstances}). */
const studyIdentifiersOf = (ordered: readonly StudyInstance[]): StudyIdentifiers => ({
  patient: Option.flatMap(Arr.head(ordered), ({ header }) => patientIdentifierOf(header)),
  accessions: Arr.dedupeWith(
    Arr.filterMap(ordered, ({ header }) =>
      Option.map(Option.fromNullable(header.accessionNumber), (accessionNumber) =>
        accessionIdentifierOf(accessionNumber, header)
      )
    ),
    (one, other) => one.key.system === other.key.system && one.key.value === other.key.value
  ),
})

/** One instance of a series, as `ImagingStudy.series.instance` carries it. */
const instanceWire = ({ header }: StudyInstance): Wire => {
  const wire: Wire = {
    uid: header.sopInstanceUid,
    sopClass: {
      system: DicomIdentifierSystem.Uid,
      code: header.sopClassUid,
    },
  }
  if (header.instanceNumber !== undefined) wire['number'] = header.instanceNumber
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
  patientKey: DetachedResource.Key,
  serviceRequestKey: Option.Option<DetachedResource.Key>,
  timeZone: string
): Wire => {
  const series = studySeries(instances)
  const head = series[0].instances[0].header

  const wire: Wire = {
    resourceType: 'ImagingStudy',
    status: 'available',
    subject: DetachedResource.logicalReferenceWire('Patient', patientKey),
    identifier: [DetachedResource.keyIdentifierWire(imagingStudyKeyOf(head))],
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

  if (Option.isSome(serviceRequestKey)) {
    wire['basedOn'] = [
      DetachedResource.logicalReferenceWire('ServiceRequest', serviceRequestKey.value),
    ]
  }

  return wire
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const decodePatient = DetachedResource.decodeUnknown(Patient.Schema)
const decodeServiceRequest = DetachedResource.decodeUnknown(ServiceRequest.Schema)
const decodeImagingStudy = DetachedResource.decodeUnknown(ImagingStudy.Schema)

type DicomFhirResources = DetachedResource.Detached<
  typeof Patient.Schema.Type | typeof ServiceRequest.Schema.Type | typeof ImagingStudy.Schema.Type
>

/**
 * Synthesize FHIR resources from one study's files.
 *
 * @param instances - Every picked file of one study — same `StudyInstanceUID`,
 *   same patient — in any order
 * @param settings - The import's settings; its `timeZone` is what
 *   `ImagingStudy.started` is resolved against (see `dates.ts`)
 * @returns The resources in write order: Patient first (when the headers name
 *   a patient, by Patient ID or by name), then ServiceRequest (when any file states an
 *   `AccessionNumber`), then the one ImagingStudy. Fails with a `ParseError`
 *   when a wire object does not satisfy its schema.
 *
 * @remarks
 * The study's *representative* header — the first instance of the first series,
 * not the first picked file — is what the `Patient` and the study's
 * describing attributes are read from, and the accession the `ServiceRequest`
 * is built from is the first stated in that same order. Every choice this
 * makes is a function of the files' headers (see {@link compareInstances}), so
 * the same study picked in any order, or re-picked file by file, synthesizes
 * identical resources under identical keys.
 *
 * Files that disagree on `AccessionNumber` or its issuer are *not* merged
 * into one request: the first is used, and {@link studyIdentifiersOf} is what
 * a caller reports the disagreement from. Files that disagree on the patient never reach here — a
 * differing patient key splits the file set upstream (`studyKey`).
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

    const identifiers = studyIdentifiersOf(ordered)
    const patientIdentifier = identifiers.patient
    if (Option.isNone(patientIdentifier)) return resources
    const patientKey = patientIdentifier.value.key
    resources.push(yield* decodePatient(patientWire(head.header, patientIdentifier.value)))

    // The accession the request is built from: the first stated in study
    // order, under the issuer the file stating it gives, which is the same one
    // for any pick order of the same files.
    const accession = Arr.head(identifiers.accessions)
    if (Option.isSome(accession)) {
      resources.push(
        yield* decodeServiceRequest(serviceRequestWire(head.header, accession.value, patientKey))
      )
    }

    resources.push(
      yield* decodeImagingStudy(
        imagingStudyWire(
          instances,
          patientKey,
          Option.map(accession, (one) => one.key),
          settings.timeZone
        )
      )
    )

    return resources
  })

export {
  fhirDate,
  fhirDateTime,
  imagingStudyKeyOf,
  orderedInstances,
  patientKeyOf,
  studyIdentifiersOf,
  studySeries,
  toFhirResources,
}
export type { StudyIdentifiers, StudyInstance, StudySeries }
