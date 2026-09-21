/**
 * The DICOM tags this package reads, as one typed record, and the reader that
 * fills it: {@link tryFromDicomFile} wraps `dicom-parser` into an `Either`.
 *
 * @packageDocumentation
 */

import { parseDicom, type DataSet } from 'dicom-parser'
import { Either } from 'effect'

import * as PersonName from './person-name.ts'
import * as PixelDataDescription from './pixel-data-description.ts'

/**
 * The DICOM tag each {@link Type} field is read from, under the standard's own
 * name for it — the one place a camel-cased field is tied to the attribute the
 * standard defines.
 */
const Tag = {
  // Patient
  PatientName: 'x00100010',
  PatientID: 'x00100020',
  IssuerOfPatientID: 'x00100021',
  PatientBirthDate: 'x00100030',
  PatientSex: 'x00100040',
  // Study
  StudyInstanceUID: 'x0020000d',
  StudyDate: 'x00080020',
  StudyTime: 'x00080030',
  StudyDescription: 'x00081030',
  AccessionNumber: 'x00080050',
  ReferringPhysicianName: 'x00080090',
  RequestedProcedureDescription: 'x00321060',
  RequestAttributesSequence: 'x00400275',
  // Series
  SeriesInstanceUID: 'x0020000e',
  SeriesNumber: 'x00200011',
  SeriesDescription: 'x0008103e',
  Modality: 'x00080060',
  BodyPartExamined: 'x00180015',
  // Instance
  SOPInstanceUID: 'x00080018',
  SOPClassUID: 'x00080016',
  InstanceNumber: 'x00200013',
  Rows: 'x00280010',
  Columns: 'x00280011',
  NumberOfFrames: 'x00280008',
  TransferSyntaxUID: 'x00020010',
  // Image Pixel — the Pixel Data element itself is read by
  // `PixelDataDescription.tryFromDataSet`, which owns its tag.
  SamplesPerPixel: 'x00280002',
  PhotometricInterpretation: 'x00280004',
  PlanarConfiguration: 'x00280006',
  BitsAllocated: 'x00280100',
  BitsStored: 'x00280101',
  HighBit: 'x00280102',
  PixelRepresentation: 'x00280103',
  WindowCenter: 'x00281050',
  WindowWidth: 'x00281051',
  RescaleIntercept: 'x00281052',
  RescaleSlope: 'x00281053',
  // Equipment
  Manufacturer: 'x00080070',
  ManufacturerModelName: 'x00081090',
  InstitutionName: 'x00080080',
} as const

/**
 * The DICOM tags this package reads, grouped by module.
 *
 * @remarks
 * Two audiences share one type. The Patient, Study, Series, Instance and
 * Equipment modules are what `dicom-importer-core` synthesizes FHIR from. The
 * Image Pixel module and {@link Type.pixelData} are read by nothing in that
 * synthesis — they exist so a preview can explain why a file did not render.
 *
 * Every field is optional except the three instance UIDs, which a file must
 * carry to parse at all, and the two that describe the parse rather than a
 * tag: `hasRequestAttributesSequence` and `parserWarnings`.
 */
interface Type {
  // Patient module
  readonly patientName: PersonName.Type | undefined
  readonly patientId: string | undefined
  readonly issuerOfPatientId: string | undefined
  readonly patientBirthDate: string | undefined
  readonly patientSex: string | undefined

  // Study module
  readonly studyInstanceUid: string
  readonly studyDate: string | undefined
  readonly studyTime: string | undefined
  readonly studyDescription: string | undefined
  readonly accessionNumber: string | undefined
  readonly referringPhysicianName: PersonName.Type | undefined
  readonly requestedProcedureDescription: string | undefined
  readonly hasRequestAttributesSequence: boolean

  // Series module
  readonly seriesInstanceUid: string
  readonly seriesNumber: number | undefined
  readonly seriesDescription: string | undefined
  readonly modality: string | undefined
  readonly bodyPartExamined: string | undefined

  // Instance module
  readonly sopInstanceUid: string
  readonly sopClassUid: string | undefined
  readonly instanceNumber: number | undefined
  readonly rows: number | undefined
  readonly columns: number | undefined
  readonly numberOfFrames: number | undefined
  readonly transferSyntaxUid: string | undefined

  // Image Pixel module — how the frames are encoded, for decode debugging
  readonly samplesPerPixel: number | undefined
  readonly photometricInterpretation: string | undefined
  /** See `PlanarConfiguration.meaning` for the enumerated values. */
  readonly planarConfiguration: number | undefined
  readonly bitsAllocated: number | undefined
  readonly bitsStored: number | undefined
  readonly highBit: number | undefined
  /** See `PixelRepresentation.meaning` for the enumerated values. */
  readonly pixelRepresentation: number | undefined
  readonly rescaleIntercept: number | undefined
  readonly rescaleSlope: number | undefined
  /**
   * Window Center (0028,1050) and Width (0028,1051) as the raw DS values,
   * backslash separators and all — both are VM 1-n, and a file carrying the
   * several presets a viewer offers is exactly the case worth seeing whole.
   * The rescale pair beside them is VM 1, so it reads back as a number.
   */
  readonly windowCenter: string | undefined
  readonly windowWidth: string | undefined
  readonly pixelData: PixelDataDescription.Type | undefined

  // Equipment module
  readonly manufacturer: string | undefined
  readonly manufacturerModelName: string | undefined
  readonly institutionName: string | undefined

  /**
   * What `dicom-parser` complained about while still returning a dataset —
   * an unexpected tag inside the pixel data, a missing sequence delimiter.
   * Empty for a well-formed file.
   */
  readonly parserWarnings: readonly string[]
}

/** A reason {@link tryFromDicomFile} could not read the bytes. */
interface ParseError {
  readonly reason: string
}

/**
 * How one {@link Type} field is filled from a parsed dataset.
 *
 * @remarks
 * A `Left` is fatal for the whole header, not for the field — an absent
 * optional tag is a `Right(undefined)`. Only the three instance UIDs, which a
 * file that is a DICOM instance at all must carry, can fail.
 */
type Reader<A> = (dataSet: DataSet) => Either.Either<A, ParseError>

/**
 * A tag's value as a trimmed string, or `undefined`.
 *
 * @remarks
 * DICOM pads a value to an even length with a space, so a writer holding no
 * value for an attribute it still emits leaves the padding alone behind. A
 * blank value is absence, not an empty string.
 */
const trimmedString = (dataSet: DataSet, tag: string): string | undefined => {
  const value = dataSet.string(tag)
  return value === undefined ? undefined : value.trim() || undefined
}

/** Read a plain string tag, trimmed. */
const readString =
  (tag: string): Reader<string | undefined> =>
  (dataSet) =>
    Either.right(trimmedString(dataSet, tag))

// DA (Date) and TM (Time) are carried as their raw strings — `'19800101'`,
// `'143000.000'` — so they read exactly as a plain string does. They are named
// apart so the table below says which VR each tag carries.
const readDa = readString
const readTm = readString

/** A UI (UID) tag's value, trimmed of the null bytes the spec pads UIDs with. */
const uid = (dataSet: DataSet, tag: string): string | undefined => {
  const value = dataSet.string(tag)
  return value === undefined ? undefined : value.replaceAll('\0', '').trim() || undefined
}

/** Read a UI (UID) tag. */
const readUi =
  (tag: string): Reader<string | undefined> =>
  (dataSet) =>
    Either.right(uid(dataSet, tag))

/**
 * Read a UI tag the file must carry, failing the whole parse when it is absent.
 *
 * @param label - How the missing tag is named in the failure, e.g.
 *   `'StudyInstanceUID (0020,000D)'`
 */
const readRequiredUi =
  (tag: string, label: string): Reader<string> =>
  (dataSet) => {
    const value = uid(dataSet, tag)
    return value === undefined ? Either.left({ reason: `Missing ${label}` }) : Either.right(value)
  }

/**
 * A numeric-string value that parsed to an actual number.
 *
 * @remarks
 * `dicom-parser`'s `intString`/`floatString` are `parseInt`/`parseFloat` over
 * the raw value, so a present-but-blank element — a padded `"  "`, which
 * writers emit for an attribute they hold no value for — yields `NaN`. `NaN`
 * is not nullish, so it survives a `?? undefined` and reaches FHIR synthesis
 * as a number the file does not carry. Absent is the honest reading of an
 * unparseable value.
 */
const numeric = (value: number | undefined): number | undefined =>
  value === undefined || Number.isNaN(value) ? undefined : value

/** Read an IS (Integer String) tag as a number. */
const readIs =
  (tag: string): Reader<number | undefined> =>
  (dataSet) =>
    Either.right(numeric(dataSet.intString(tag)))

/** Read a DS (Decimal String) tag as a number. */
const readDs =
  (tag: string): Reader<number | undefined> =>
  (dataSet) =>
    Either.right(numeric(dataSet.floatString(tag)))

/** Read a US (Unsigned Short) tag. */
const readUs =
  (tag: string): Reader<number | undefined> =>
  (dataSet) =>
    Either.right(dataSet.uint16(tag) ?? undefined)

/** Read a PN (Person Name) tag. */
const readPn =
  (tag: string): Reader<PersonName.Type | undefined> =>
  (dataSet) => {
    const value = dataSet.string(tag)
    return Either.right(value === undefined ? undefined : PersonName.tryFromPnString(value))
  }

/** Report whether a tag is present at all, without reading its value. */
const readPresence =
  (tag: string): Reader<boolean> =>
  (dataSet) =>
    Either.right(dataSet.elements[tag] !== undefined)

/**
 * How every {@link Type} field is read, one entry per field.
 *
 * @remarks
 * The `satisfies` is what keeps this honest: a field added to {@link Type}
 * without an entry here, or an entry whose reader produces the wrong type,
 * fails to compile. Declaration order is the order the readers run, which
 * decides which missing UID a file lacking several is reported for — Study
 * first, as the tests expect.
 */
const READERS = {
  // Patient module
  patientName: readPn(Tag.PatientName),
  patientId: readString(Tag.PatientID),
  issuerOfPatientId: readString(Tag.IssuerOfPatientID),
  patientBirthDate: readDa(Tag.PatientBirthDate),
  patientSex: readString(Tag.PatientSex),

  // Study module
  studyInstanceUid: readRequiredUi(Tag.StudyInstanceUID, 'StudyInstanceUID (0020,000D)'),
  studyDate: readDa(Tag.StudyDate),
  studyTime: readTm(Tag.StudyTime),
  studyDescription: readString(Tag.StudyDescription),
  accessionNumber: readString(Tag.AccessionNumber),
  referringPhysicianName: readPn(Tag.ReferringPhysicianName),
  requestedProcedureDescription: readString(Tag.RequestedProcedureDescription),
  hasRequestAttributesSequence: readPresence(Tag.RequestAttributesSequence),

  // Series module
  seriesInstanceUid: readRequiredUi(Tag.SeriesInstanceUID, 'SeriesInstanceUID (0020,000E)'),
  seriesNumber: readIs(Tag.SeriesNumber),
  seriesDescription: readString(Tag.SeriesDescription),
  modality: readString(Tag.Modality),
  bodyPartExamined: readString(Tag.BodyPartExamined),

  // Instance module
  sopInstanceUid: readRequiredUi(Tag.SOPInstanceUID, 'SOPInstanceUID (0008,0018)'),
  sopClassUid: readUi(Tag.SOPClassUID),
  instanceNumber: readIs(Tag.InstanceNumber),
  rows: readUs(Tag.Rows),
  columns: readUs(Tag.Columns),
  numberOfFrames: readIs(Tag.NumberOfFrames),
  transferSyntaxUid: readUi(Tag.TransferSyntaxUID),

  // Image Pixel module
  samplesPerPixel: readUs(Tag.SamplesPerPixel),
  photometricInterpretation: readString(Tag.PhotometricInterpretation),
  planarConfiguration: readUs(Tag.PlanarConfiguration),
  bitsAllocated: readUs(Tag.BitsAllocated),
  bitsStored: readUs(Tag.BitsStored),
  highBit: readUs(Tag.HighBit),
  pixelRepresentation: readUs(Tag.PixelRepresentation),
  rescaleIntercept: readDs(Tag.RescaleIntercept),
  rescaleSlope: readDs(Tag.RescaleSlope),
  windowCenter: readString(Tag.WindowCenter),
  windowWidth: readString(Tag.WindowWidth),
  pixelData: (dataSet) => Either.right(PixelDataDescription.tryFromDataSet(dataSet)),

  // Equipment module
  manufacturer: readString(Tag.Manufacturer),
  manufacturerModelName: readString(Tag.ManufacturerModelName),
  institutionName: readString(Tag.InstitutionName),

  parserWarnings: (dataSet) => Either.right([...dataSet.warnings]),
} satisfies { readonly [K in keyof Type]: Reader<Type[K]> }

/**
 * Run every reader over a parsed dataset, stopping at the first fatal one.
 *
 * @remarks
 * The lone assertion in this package. {@link READERS} is keyed and typed by
 * {@link Type}, so the accumulated record carries exactly {@link Type}'s fields
 * with exactly their types — but `Object.entries` erases that, and there is no
 * way to rebuild a heterogeneous record from its entries without saying so.
 * What the assertion claims is checked from the other side: the round-trip
 * property in `dicom-header.test.ts` asserts the whole parsed value against a
 * generated header, so a field read into the wrong shape fails there.
 */
const readHeader = (dataSet: DataSet): Either.Either<Type, ParseError> => {
  // Widened to `Reader<unknown>` so the loop reads one reader type rather than
  // the 40-way union `Object.entries` hands back, which no narrowing survives.
  const readers: readonly (readonly [string, Reader<unknown>])[] = Object.entries(READERS)
  const header: Record<string, unknown> = {}
  for (const [field, read] of readers) {
    const value = read(dataSet)
    if (Either.isLeft(value)) return Either.left(value.left)
    header[field] = value.right
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see @remarks
  return Either.right(header as unknown as Type)
}

/**
 * Parse a DICOM Part 10 file's raw bytes into a typed {@link Type}.
 *
 * @param bytes - The raw bytes of a `.dcm` file, preamble included
 * @returns `Right(DicomHeader.Type)` on success, `Left(ParseError)` when the
 *   file cannot be parsed or is missing a required UID
 */
const tryFromDicomFile = (bytes: Uint8Array): Either.Either<Type, ParseError> => {
  let dataSet: DataSet
  try {
    dataSet = parseDicom(bytes)
  } catch (error) {
    return Either.left({
      reason: error instanceof Error ? error.message : 'DICOM parse failed',
    })
  }
  return readHeader(dataSet)
}

export { tryFromDicomFile, type ParseError, type Type }
