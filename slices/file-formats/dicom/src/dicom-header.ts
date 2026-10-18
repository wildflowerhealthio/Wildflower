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
import * as SpecificCharacterSet from './specific-character-set.ts'

/**
 * The DICOM tag each {@link Type} field is read from, under the standard's own
 * name for it — the one place a camel-cased field is tied to the attribute the
 * standard defines.
 */
const Tag = {
  // SOP Common — read first, since it says how every text value is decoded
  SpecificCharacterSet: 'x00080005',
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
 * Every field is optional except the three instance UIDs, the SOP Class UID
 * and the Modality — which a file must carry for the synthesis above to name
 * what it is — and the two that describe the parse rather than a tag:
 * `hasRequestAttributesSequence` and `parserWarnings`.
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
  readonly modality: string
  readonly bodyPartExamined: string | undefined

  // Instance module
  readonly sopInstanceUid: string
  readonly sopClassUid: string
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
 * How one {@link Type} field is filled from a parsed dataset, under the file's
 * Specific Character Set (0008,0005).
 *
 * @remarks
 * A `Left` is fatal for the whole header, not for the field — an absent
 * optional tag is a `Right(undefined)`. Only a required tag the file lacks, or
 * a text value its declared character set cannot decode, fails. A reader of a
 * VR held to the default repertoire ignores the character set.
 */
type Reader<A> = (
  dataSet: DataSet,
  characterSet: SpecificCharacterSet.Type
) => Either.Either<A, ParseError | SpecificCharacterSet.UndecodableText>

/**
 * A tag's value as a trimmed string, or `undefined`, read byte for byte as
 * `dicom-parser` does.
 *
 * @remarks
 * Only for the VRs PS3.5 6.1.2.3 holds to the default repertoire — AE, AS,
 * CS, DA, DS, DT, IS, TM and UI — whose bytes mean the same under every
 * character set. Text VRs go through {@link decodedText}.
 *
 * DICOM pads a value to an even length with a space, so a writer holding no
 * value for an attribute it still emits leaves the padding alone behind. A
 * blank value is absence, not an empty string.
 */
const trimmedString = (dataSet: DataSet, tag: string): string | undefined => {
  const value = dataSet.string(tag)
  return value === undefined ? undefined : value.trim() || undefined
}

/** Read a default-repertoire string tag (CS, DS), trimmed. */
const readDefaultRepertoire =
  (tag: string): Reader<string | undefined> =>
  (dataSet) =>
    Either.right(trimmedString(dataSet, tag))

// DA (Date) and TM (Time) are carried as their raw strings — `'19800101'`,
// `'143000.000'` — so they read exactly as any other default-repertoire value
// does. They are named apart so the table below says which VR each tag carries.
const readDa = readDefaultRepertoire
const readTm = readDefaultRepertoire

/** NUL, which some writers pad a text value with; nothing after it is read. */
const NUL = 0x00

/**
 * A text tag's value (LO, SH, PN), decoded under the file's character set and
 * trimmed, or `undefined`.
 *
 * @remarks
 * The whole value is decoded before anything splits it, so a multi-byte
 * character whose trail byte is `\` or `^` stays whole. Bytes from the
 * first NUL on are dropped, as `dicom-parser` drops them; no supported set
 * uses 0x00 inside a character. A blank value is absence, as in
 * {@link trimmedString}.
 *
 * @param label - How the tag is named in a decode failure, e.g.
 *   `'PatientName (0010,0010)'`
 */
const decodedText = (
  dataSet: DataSet,
  characterSet: SpecificCharacterSet.Type,
  tag: string,
  label: string
): Either.Either<string | undefined, SpecificCharacterSet.UndecodableText> => {
  const element = dataSet.elements[tag]
  if (element === undefined) return Either.right(undefined)
  const value = dataSet.byteArray.subarray(element.dataOffset, element.dataOffset + element.length)
  const end = value.indexOf(NUL)
  return Either.map(
    SpecificCharacterSet.decode(characterSet, end === -1 ? value : value.subarray(0, end), label),
    (text) => text.trim() || undefined
  )
}

/**
 * Read a text tag (LO, SH) under the file's character set.
 *
 * @param label - How the tag is named in a decode failure, e.g.
 *   `'InstitutionName (0008,0080)'`
 */
const readText =
  (tag: string, label: string): Reader<string | undefined> =>
  (dataSet, characterSet) =>
    decodedText(dataSet, characterSet, tag, label)

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
 * Read a string tag the file must carry, failing the whole parse when it is
 * absent.
 *
 * @param label - How the missing tag is named in the failure, e.g.
 *   `'Modality (0008,0060)'`
 */
const readRequiredString =
  (tag: string, label: string): Reader<string> =>
  (dataSet) => {
    const value = trimmedString(dataSet, tag)
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

/**
 * Read a PN (Person Name) tag under the file's character set.
 *
 * @param label - How the tag is named in a decode failure, e.g.
 *   `'PatientName (0010,0010)'`
 */
const readPn =
  (tag: string, label: string): Reader<PersonName.Type | undefined> =>
  (dataSet, characterSet) =>
    Either.map(decodedText(dataSet, characterSet, tag, label), (value) =>
      value === undefined ? undefined : PersonName.tryFromPnString(value)
    )

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
  patientName: readPn(Tag.PatientName, 'PatientName (0010,0010)'),
  patientId: readText(Tag.PatientID, 'PatientID (0010,0020)'),
  issuerOfPatientId: readText(Tag.IssuerOfPatientID, 'IssuerOfPatientID (0010,0021)'),
  patientBirthDate: readDa(Tag.PatientBirthDate),
  patientSex: readDefaultRepertoire(Tag.PatientSex),

  // Study module
  studyInstanceUid: readRequiredUi(Tag.StudyInstanceUID, 'StudyInstanceUID (0020,000D)'),
  studyDate: readDa(Tag.StudyDate),
  studyTime: readTm(Tag.StudyTime),
  studyDescription: readText(Tag.StudyDescription, 'StudyDescription (0008,1030)'),
  accessionNumber: readText(Tag.AccessionNumber, 'AccessionNumber (0008,0050)'),
  referringPhysicianName: readPn(Tag.ReferringPhysicianName, 'ReferringPhysicianName (0008,0090)'),
  requestedProcedureDescription: readText(
    Tag.RequestedProcedureDescription,
    'RequestedProcedureDescription (0032,1060)'
  ),
  hasRequestAttributesSequence: readPresence(Tag.RequestAttributesSequence),

  // Series module
  seriesInstanceUid: readRequiredUi(Tag.SeriesInstanceUID, 'SeriesInstanceUID (0020,000E)'),
  seriesNumber: readIs(Tag.SeriesNumber),
  seriesDescription: readText(Tag.SeriesDescription, 'SeriesDescription (0008,103E)'),
  modality: readRequiredString(Tag.Modality, 'Modality (0008,0060)'),
  bodyPartExamined: readDefaultRepertoire(Tag.BodyPartExamined),

  // Instance module
  sopInstanceUid: readRequiredUi(Tag.SOPInstanceUID, 'SOPInstanceUID (0008,0018)'),
  sopClassUid: readRequiredUi(Tag.SOPClassUID, 'SOPClassUID (0008,0016)'),
  instanceNumber: readIs(Tag.InstanceNumber),
  rows: readUs(Tag.Rows),
  columns: readUs(Tag.Columns),
  numberOfFrames: readIs(Tag.NumberOfFrames),
  transferSyntaxUid: readUi(Tag.TransferSyntaxUID),

  // Image Pixel module
  samplesPerPixel: readUs(Tag.SamplesPerPixel),
  photometricInterpretation: readDefaultRepertoire(Tag.PhotometricInterpretation),
  planarConfiguration: readUs(Tag.PlanarConfiguration),
  bitsAllocated: readUs(Tag.BitsAllocated),
  bitsStored: readUs(Tag.BitsStored),
  highBit: readUs(Tag.HighBit),
  pixelRepresentation: readUs(Tag.PixelRepresentation),
  rescaleIntercept: readDs(Tag.RescaleIntercept),
  rescaleSlope: readDs(Tag.RescaleSlope),
  windowCenter: readDefaultRepertoire(Tag.WindowCenter),
  windowWidth: readDefaultRepertoire(Tag.WindowWidth),
  pixelData: (dataSet) => Either.right(PixelDataDescription.tryFromDataSet(dataSet)),

  // Equipment module
  manufacturer: readText(Tag.Manufacturer, 'Manufacturer (0008,0070)'),
  manufacturerModelName: readText(Tag.ManufacturerModelName, 'ManufacturerModelName (0008,1090)'),
  institutionName: readText(Tag.InstitutionName, 'InstitutionName (0008,0080)'),

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
const readHeader = (
  dataSet: DataSet
): Either.Either<Type, ParseError | SpecificCharacterSet.UndecodableText> => {
  const characterSet = SpecificCharacterSet.fromValue(dataSet.string(Tag.SpecificCharacterSet))
  if (Either.isLeft(characterSet)) return Either.left(characterSet.left)
  // Widened to `Reader<unknown>` so the loop reads one reader type rather than
  // the 40-way union `Object.entries` hands back, which no narrowing survives.
  const readers: readonly (readonly [string, Reader<unknown>])[] = Object.entries(READERS)
  const header: Record<string, unknown> = {}
  for (const [field, read] of readers) {
    const value = read(dataSet, characterSet.right)
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
 * @returns `Right(DicomHeader.Type)` on success; `Left(ParseError)` when the
 *   file cannot be parsed or is missing a required tag; and
 *   `Left(SpecificCharacterSet.UndecodableText)` when its Specific Character
 *   Set (0008,0005) is unsupported or a text value cannot be decoded under it
 */
const tryFromDicomFile = (
  bytes: Uint8Array
): Either.Either<Type, ParseError | SpecificCharacterSet.UndecodableText> => {
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
