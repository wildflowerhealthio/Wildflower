import { dicomImporter } from 'dicom-importer-core'
import { Data, DateTime, Effect, Either, type ParseResult } from 'effect'
import type { ReferenceType } from 'fhir-r4/data-types'
import type { FhirResource } from 'fhir-r4/resources'

import * as Person from '../person.ts'
import * as Seeded from '../seeded.ts'
import * as StoryDay from '../story-day.ts'
import * as Part10 from './part10.ts'

/**
 * The DICOM renderer: a real, already de-identified image re-identified as a
 * person in a story, and read back through the DICOM importer.
 *
 * @remarks
 * Pixels cannot be generated plausibly, so this source starts from a real
 * image — a de-identified Part 10 file the data set carries under its own
 * licence — and changes only its header ({@link reidentify}):
 *
 * - the patient (`PatientID`, name, sex, birth date) is the person's;
 * - the study, series, acquisition and content dates are the story day, at a
 *   time of day hashed from the person and image; `AcquisitionDateTime` is
 *   rewritten to match when present, and every other top-level date or time,
 *   and `PatientAge`, is removed — each counts from the source's calendar;
 * - the Study, Series and SOP Instance UIDs, and every other top-level
 *   instance UID (Frame of Reference, referenced instances), are minted from
 *   the person's and image's keys under {@link UID_ROOT};
 *   `MediaStorageSOPInstanceUID` follows the SOP Instance UID;
 * - private (odd-group) elements and data set group lengths are removed;
 * - `ImageType` becomes `DERIVED\PRIMARY` (see {@link DERIVED_PRIMARY});
 * - `PatientIdentityRemoved` stays `YES`, `DeidentificationMethod` gains a
 *   value saying the identity is synthetic, and
 *   `LongitudinalTemporalInformationModified` is `MODIFIED`.
 *
 * Pixel Data, and every element not named above, is copied byte for byte.
 * Sequences are copied whole: only top-level elements are rewritten, so a
 * private element, date or instance UID nested in a sequence keeps the
 * source's value. A source for this renderer is one whose sequences carry
 * none of those (a de-identification profile that cleans or removes them).
 *
 * {@link importWithSubject} then reads the result as the DICOM importer does
 * and files it on the person's Patient from another source.
 */

/** A value {@link reidentify} was asked to write that its VR cannot hold. */
class UnencodableValue extends Data.TaggedError('UnencodableValue')<{
  readonly reason: string
}> {}

/** A re-identification the DICOM importer could not read back. */
class UnreadableReidentifiedFile extends Data.TaggedError('UnreadableReidentifiedFile')<{
  readonly error: ParseResult.ParseError
}> {}

/** Who and when a de-identified image is re-identified as. */
interface Reidentification {
  /** The patient: name, sex and birth date. */
  readonly person: Person.Person
  /** The id the imaging site files the patient under (`PatientID`, LO). */
  readonly patientId: string
  /** The day the image was taken. */
  readonly studyDay: StoryDay.StoryDay
  /** The order's accession number (SH), when the study was ordered under one. */
  readonly accessionNumber: string | undefined
  /**
   * A stable handle for this image within the person's record
   * (`'chest-x-ray'`). Every minted UID and the time of day are hashed from
   * the person's key and it.
   */
  readonly imageKey: string
}

/**
 * The root every minted UID sits under: `2.25.` and the decimal form of a
 * UUID (`668234a0-2076-4f64-bf93-f2e39892514b`), which PS3.5 B.2 lets anyone
 * use without registering an organizational root.
 *
 * @remarks
 * 44 characters, leaving room for one 15-digit arc within UI's 64.
 */
const UID_ROOT = '2.25.136257321533522887283482111752379978059'

/** Digits in the arc a minted UID adds to {@link UID_ROOT}. */
const UID_ARC_DIGITS = 15

/** A UID under {@link UID_ROOT}, hashed from `keys`. */
const uidOf = (keys: readonly string[]): string =>
  `${UID_ROOT}.${Seeded.digitsOf(keys, UID_ARC_DIGITS)}`

/** What every value hashed for an image is keyed by: its person and its handle. */
const imageKeysOf = (reidentification: Reidentification): readonly string[] => [
  reidentification.person.key,
  'dicom',
  reidentification.imageKey,
]

/** The image's SOP Instance UID, which the file meta repeats. */
const sopInstanceUidOf = (imageKeys: readonly string[]): string =>
  uidOf([...imageKeys, 'sop-instance'])

/** The root of every UID the DICOM standard itself defines (SOP classes, transfer syntaxes). */
const DICOM_DEFINED_UID_ROOT = '1.2.840.10008.'

/**
 * `ImageType` Values 1 and 2.
 *
 * @remarks
 * `DERIVED` because the pixels are no longer what the modality wrote — a data
 * set's image is typically resampled — and the header around them is
 * synthetic. `PRIMARY` rather than `SECONDARY` because they are still the
 * examination's own image, not one made from it afterwards (a reformat, a
 * screen capture), and because the DX, MG and IO image modules allow Value 2
 * only `PRIMARY`.
 */
const DERIVED_PRIMARY = ['DERIVED', 'PRIMARY'] as const

/** The value {@link reidentify} adds to `DeidentificationMethod`. */
const SYNTHETIC_IDENTITY_METHOD = 'Synthetic re-identification: patient, dates and UIDs replaced'

/** The earliest and latest hour (exclusive) of the equipment's clock an image is taken at. */
const ACQUISITION_HOURS = { from: 8, to: 18 } as const

/**
 * The zone the equipment's clock is set to, which the import reads each
 * `StudyDate`/`StudyTime` in — Toronto, as the data set's other sources.
 */
const EQUIPMENT_TIME_ZONE = 'America/Toronto'

const Tag = {
  MediaStorageSOPInstanceUID: 0x0002_0003,
  ImageType: 0x0008_0008,
  SOPClassUID: 0x0008_0016,
  SOPInstanceUID: 0x0008_0018,
  StudyDate: 0x0008_0020,
  SeriesDate: 0x0008_0021,
  AcquisitionDate: 0x0008_0022,
  ContentDate: 0x0008_0023,
  AcquisitionDateTime: 0x0008_002a,
  StudyTime: 0x0008_0030,
  SeriesTime: 0x0008_0031,
  AcquisitionTime: 0x0008_0032,
  ContentTime: 0x0008_0033,
  AccessionNumber: 0x0008_0050,
  PatientName: 0x0010_0010,
  PatientID: 0x0010_0020,
  PatientBirthDate: 0x0010_0030,
  PatientSex: 0x0010_0040,
  PatientAge: 0x0010_1010,
  PatientIdentityRemoved: 0x0012_0062,
  DeidentificationMethod: 0x0012_0063,
  StudyInstanceUID: 0x0020_000d,
  SeriesInstanceUID: 0x0020_000e,
  LongitudinalTemporalInformationModified: 0x0028_0303,
} as const

/** The longest value (in characters) PS3.5 Table 6.2-1 allows each VR written here. */
const MAX_LENGTH: Readonly<Record<string, number>> = {
  CS: 16,
  DA: 8,
  DT: 26,
  LO: 64,
  PN: 64,
  SH: 16,
  TM: 16,
  UI: 64,
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * Printable ASCII other than the backslash, which separates values — the
 * characters every character set a file can declare agrees on, so a value is
 * readable whatever `SpecificCharacterSet` the source states.
 */
const PORTABLE_TEXT = /^[\x20-\x5b\x5d-\x7e]*$/

/** One element's value, checked against its VR and padded to even length. */
const valueOf = (
  tag: number,
  vr: string,
  values: readonly string[]
): Either.Either<Part10.DataElement, UnencodableValue> => {
  const maxLength = MAX_LENGTH[vr] ?? Number.POSITIVE_INFINITY
  const invalid = values.find((value) => !PORTABLE_TEXT.test(value) || value.length > maxLength)
  if (invalid !== undefined) {
    return Either.left(
      new UnencodableValue({
        reason: `${Part10.tagLabelOf(tag)} ${vr} cannot hold ${JSON.stringify(invalid)}: at most ${maxLength} printable ASCII characters, no backslash.`,
      })
    )
  }
  const raw = textEncoder.encode(values.join('\\'))
  const value = new Uint8Array(raw.length + (raw.length % 2))
  value.set(raw)
  if (raw.length % 2 === 1) value[raw.length] = vr === 'UI' ? 0x00 : 0x20
  return Either.right({ tag, vr, value, undefinedLength: false })
}

/** An element's values as text, padding trimmed. */
const valuesOf = (element: Part10.DataElement): readonly string[] =>
  textDecoder
    .decode(element.value)
    .replace(/[\0 ]+$/, '')
    .split('\\')
    .map((value) => value.trim())

/** `DA` for a calendar day (`YYYYMMDD`). */
const daOf = (day: DateTime.Utc): string => DateTime.formatIsoDate(day).replaceAll('-', '')

/** `TM` for a second of the day (`HHMMSS`). */
const tmOf = (secondOfDay: number): string =>
  [Math.floor(secondOfDay / 3600), Math.floor(secondOfDay / 60) % 60, secondOfDay % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join('')

/** DICOM's code for FHIR administrative gender. */
const SEX: Readonly<Record<Person.Gender, string>> = { male: 'M', female: 'F' }

/** The elements {@link reidentify} writes over whatever the source states for them. */
const rewrittenElementsOf = (
  asOf: DateTime.Utc,
  reidentification: Reidentification,
  source: ReadonlyMap<number, Part10.DataElement>
): Either.Either<readonly Part10.DataElement[], UnencodableValue> => {
  const { person } = reidentification
  const keys = imageKeysOf(reidentification)
  const studyDa = daOf(StoryDay.toDateTime(asOf, reidentification.studyDay))
  const acquiredTm = tmOf(
    Seeded.integerOf(
      [...keys, 'acquired'],
      ACQUISITION_HOURS.from * 3600,
      ACQUISITION_HOURS.to * 3600 - 1
    )
  )
  const sourceImageType = source.get(Tag.ImageType)
  const deidentificationMethod = source.get(Tag.DeidentificationMethod)
  const written: Either.Either<Part10.DataElement, UnencodableValue>[] = [
    valueOf(Tag.ImageType, 'CS', [
      ...DERIVED_PRIMARY,
      ...(sourceImageType === undefined ? [] : valuesOf(sourceImageType).slice(2)),
    ]),
    valueOf(Tag.SOPInstanceUID, 'UI', [sopInstanceUidOf(keys)]),
    valueOf(Tag.StudyDate, 'DA', [studyDa]),
    valueOf(Tag.SeriesDate, 'DA', [studyDa]),
    valueOf(Tag.AcquisitionDate, 'DA', [studyDa]),
    valueOf(Tag.ContentDate, 'DA', [studyDa]),
    valueOf(Tag.StudyTime, 'TM', [acquiredTm]),
    valueOf(Tag.SeriesTime, 'TM', [acquiredTm]),
    valueOf(Tag.AcquisitionTime, 'TM', [acquiredTm]),
    valueOf(Tag.ContentTime, 'TM', [acquiredTm]),
    valueOf(Tag.AccessionNumber, 'SH', [reidentification.accessionNumber ?? '']),
    valueOf(Tag.PatientName, 'PN', [`${person.familyName}^${person.givenName}`]),
    valueOf(Tag.PatientID, 'LO', [reidentification.patientId]),
    valueOf(Tag.PatientBirthDate, 'DA', [daOf(Person.birthDateOf(person, asOf))]),
    valueOf(Tag.PatientSex, 'CS', [SEX[person.gender]]),
    valueOf(Tag.PatientIdentityRemoved, 'CS', ['YES']),
    valueOf(Tag.DeidentificationMethod, 'LO', [
      ...(deidentificationMethod === undefined
        ? []
        : valuesOf(deidentificationMethod).filter((method) => method !== '')),
      SYNTHETIC_IDENTITY_METHOD,
    ]),
    valueOf(Tag.StudyInstanceUID, 'UI', [uidOf([...keys, 'study-instance'])]),
    valueOf(Tag.SeriesInstanceUID, 'UI', [uidOf([...keys, 'series-instance'])]),
    valueOf(Tag.LongitudinalTemporalInformationModified, 'CS', ['MODIFIED']),
  ]
  if (source.has(Tag.AcquisitionDateTime)) {
    written.push(valueOf(Tag.AcquisitionDateTime, 'DT', [`${studyDa}${acquiredTm}`]))
  }
  return Either.all(written)
}

/**
 * Whether an element is dropped: private, a data set group length (which the
 * edits would falsify), `PatientAge`, or a date or time this renderer does not
 * write.
 */
const isDropped = (element: Part10.DataElement): boolean =>
  Part10.isPrivate(element) ||
  (element.tag & 0xffff) === 0 ||
  element.tag === Tag.PatientAge ||
  element.vr === 'DA' ||
  element.vr === 'DT' ||
  element.vr === 'TM'

/**
 * An instance UID the source carries that this renderer does not mint by name
 * — a Frame of Reference, a referenced instance — replaced by one minted from
 * the source's value, so two references to one source UID still agree. UIDs
 * the standard defines (a SOP class) are kept.
 */
const withRemintedUids =
  (keys: readonly string[]) =>
  (element: Part10.DataElement): Either.Either<Part10.DataElement, UnencodableValue> =>
    element.vr !== 'UI' || element.tag === Tag.SOPClassUID
      ? Either.right(element)
      : valueOf(
          element.tag,
          'UI',
          valuesOf(element).map((uid) =>
            uid === '' || uid.startsWith(DICOM_DEFINED_UID_ROOT)
              ? uid
              : uidOf([...keys, 'uid', uid])
          )
        )

/**
 * Re-identify a de-identified DICOM Part 10 file as a person on a story day.
 *
 * @param asOf - The as-of instant every story day is dated from; only its UTC
 *   calendar day matters
 * @param deidentifiedFile - The source file's bytes: Explicit VR Little Endian
 *   data set, `PatientIdentityRemoved` (0012,0062) `YES`
 * @param reidentification - Who the image is of, and when it was taken
 * @returns The re-identified file's bytes, identical for identical inputs; an
 *   {@link Part10.UnsupportedDicomFile} for a file this cannot read or that is
 *   not marked de-identified, or an {@link UnencodableValue} for a patient id,
 *   name or accession number its VR cannot hold
 */
const reidentify = (
  asOf: DateTime.Utc,
  deidentifiedFile: Uint8Array,
  reidentification: Reidentification
): Either.Either<Uint8Array, Part10.UnsupportedDicomFile | UnencodableValue> =>
  Either.gen(function* () {
    const source = yield* Part10.decode(deidentifiedFile)
    const sourceElements = new Map(source.dataSet.map((element) => [element.tag, element]))
    const identityRemoved = sourceElements.get(Tag.PatientIdentityRemoved)
    if (identityRemoved === undefined || valuesOf(identityRemoved)[0] !== 'YES') {
      return yield* Either.left(
        new Part10.UnsupportedDicomFile({
          reason:
            'PatientIdentityRemoved (0012,0062) is not YES; only a de-identified file is re-identified.',
        })
      )
    }
    const keys = imageKeysOf(reidentification)
    const rewritten = yield* rewrittenElementsOf(asOf, reidentification, sourceElements)
    const rewrittenTags = new Set(rewritten.map((element) => element.tag))
    const kept = yield* Either.all(
      source.dataSet
        .filter((element) => !rewrittenTags.has(element.tag) && !isDropped(element))
        .map(withRemintedUids(keys))
    )
    const mediaStorageSopInstanceUid = yield* valueOf(Tag.MediaStorageSOPInstanceUID, 'UI', [
      sopInstanceUidOf(keys),
    ])
    const meta = [
      ...source.meta.filter((element) => element.tag !== Tag.MediaStorageSOPInstanceUID),
      mediaStorageSopInstanceUid,
    ].toSorted(Part10.byTag)
    return Part10.encode({
      preamble: new Uint8Array(source.preamble.length),
      meta,
      dataSet: [...kept, ...rewritten].toSorted(Part10.byTag),
    })
  })

/** `resource` filed on `subject`, if it is one of the DICOM import's resources that names a patient. */
const withSubject =
  (subject: ReferenceType) =>
  (resource: FhirResource): FhirResource => {
    if (resource.resourceType === 'ImagingStudy') return { ...resource, subject }
    if (resource.resourceType === 'ServiceRequest') return { ...resource, subject }
    if (resource.resourceType === 'DocumentReference') return { ...resource, subject }
    return resource
  }

/**
 * Read a re-identified file as the DICOM importer does, and file what it
 * makes on a Patient another source's import made for the person.
 *
 * @param reidentifiedFile - A file {@link reidentify} wrote
 * @param fileName - The name the file is picked under, which the source-file
 *   `DocumentReference` records
 * @param subject - The person's Patient, as a reference every resource files
 *   under
 * @returns What `dicomImporter.decode` makes of the file — the source-file
 *   `DocumentReference` carrying its bytes, the `ImagingStudy` and, when an
 *   accession number was written, the `ServiceRequest` — adopted under
 *   `DICOM_SYSTEM`, with no `Patient` and every `subject` replaced by
 *   `subject`; an {@link UnreadableReidentifiedFile} if the importer rejects it
 *
 * @remarks
 * The import reads `StudyDate`/`StudyTime` in {@link EQUIPMENT_TIME_ZONE}, not
 * the runtime's zone, so the same file imports to the same instants anywhere.
 */
const importWithSubject = (
  reidentifiedFile: Uint8Array,
  fileName: string,
  subject: ReferenceType
): Effect.Effect<readonly FhirResource[], UnreadableReidentifiedFile> =>
  Effect.gen(function* () {
    const result = yield* dicomImporter.decode(
      [{ id: `0:${fileName}`, fileName, bytes: reidentifiedFile }],
      { timeZone: EQUIPMENT_TIME_ZONE }
    )
    const [unreadable] = result.unreadableFiles
    if (unreadable !== undefined) {
      return yield* new UnreadableReidentifiedFile({ error: unreadable.error })
    }
    return result.decoded.sections
      .flatMap((section) => section.resources.map((entry) => entry.resource))
      .filter((resource) => resource.resourceType !== 'Patient')
      .map(withSubject(subject))
  })

export {
  DERIVED_PRIMARY,
  EQUIPMENT_TIME_ZONE,
  importWithSubject,
  reidentify,
  UID_ROOT,
  UnencodableValue,
  UnreadableReidentifiedFile,
}
export type { Reidentification }
