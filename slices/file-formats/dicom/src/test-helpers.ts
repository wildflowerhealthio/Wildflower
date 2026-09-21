/**
 * Test-only DICOM Part 10 writer and fast-check arbitraries for
 * {@link DicomHeader.Type}. Every DICOM test in the repo synthesizes fixtures
 * from these helpers; no `.dcm` files are committed.
 *
 * @packageDocumentation
 */
import * as fc from 'fast-check'

import type * as DicomHeader from './dicom-header.ts'
import type * as PersonName from './person-name.ts'
import type * as PixelDataDescription from './pixel-data-description.ts'

// ---------------------------------------------------------------------------
// Minimal explicit-VR little-endian DICOM writer
// ---------------------------------------------------------------------------

/** DICOM tag as a `(group, element)` pair — both are 16-bit unsigned ints. */
interface TagAddress {
  readonly group: number
  readonly element: number
}

/** Parse `'x00100010'` → `{ group: 0x0010, element: 0x0010 }`. */
const parseTag = (hex: string): TagAddress => ({
  group: parseInt(hex.slice(1, 5), 16),
  element: parseInt(hex.slice(5, 9), 16),
})

const textEncoder = new TextEncoder()

/** Encode a string value into bytes, padded to even length with a space. */
const encodeString = (value: string): Uint8Array => {
  const raw = textEncoder.encode(value)
  if (raw.length % 2 === 0) return raw
  const padded = new Uint8Array(raw.length + 1)
  padded.set(raw)
  padded[raw.length] = 0x20
  return padded
}

/** Encode a UID value, padded to even length with a null byte. */
const encodeUid = (value: string): Uint8Array => {
  const raw = textEncoder.encode(value)
  if (raw.length % 2 === 0) return raw
  const padded = new Uint8Array(raw.length + 1)
  padded.set(raw)
  padded[raw.length] = 0x00
  return padded
}

/** Write a single explicit-VR data element. */
const writeElement = (tag: TagAddress, vr: string, valueBytes: Uint8Array): Uint8Array => {
  const vrBytes = textEncoder.encode(vr)
  // VRs with 4-byte length header
  const longVrs = new Set(['OB', 'OD', 'OF', 'OL', 'OW', 'SQ', 'UC', 'UN', 'UR', 'UT'])
  const isLong = longVrs.has(vr)
  const headerSize = isLong ? 12 : 8
  const result = new Uint8Array(headerSize + valueBytes.length)
  const view = new DataView(result.buffer)

  // Tag: group (LE) + element (LE)
  view.setUint16(0, tag.group, true)
  view.setUint16(2, tag.element, true)
  // VR: 2 ASCII bytes
  result[4] = vrBytes[0]!
  result[5] = vrBytes[1]!

  if (isLong) {
    // 2 reserved bytes (already 0) + 4-byte length
    view.setUint32(8, valueBytes.length, true)
    result.set(valueBytes, 12)
  } else {
    // 2-byte length
    view.setUint16(6, valueBytes.length, true)
    result.set(valueBytes, 8)
  }
  return result
}

/** Write an explicit-VR string element. */
const writeStringElement = (tagHex: string, vr: string, value: string): Uint8Array => {
  const tag = parseTag(tagHex)
  const bytes = vr === 'UI' ? encodeUid(value) : encodeString(value)
  return writeElement(tag, vr, bytes)
}

/** Write a US (unsigned short) element. */
const writeUsElement = (tagHex: string, value: number): Uint8Array => {
  const tag = parseTag(tagHex)
  const valueBytes = new Uint8Array(2)
  new DataView(valueBytes.buffer).setUint16(0, value, true)
  return writeElement(tag, 'US', valueBytes)
}

/**
 * A numeric-string (IS or DS) fixture value.
 *
 * @remarks
 * A `string` writes the value verbatim, which is how a test produces the
 * malformed shapes a real file carries — a padded `'  '` for an attribute the
 * writer held no value for — and which `String(number)` cannot express. A
 * writer that can only emit well-formed values cannot exercise the parser's
 * handling of ill-formed ones.
 */
type NumericString = number | string

/** Write an IS (integer string) element. */
const writeIsElement = (tagHex: string, value: NumericString): Uint8Array =>
  writeStringElement(tagHex, 'IS', String(value))

/** Write a DS (decimal string) element. */
const writeDsElement = (tagHex: string, value: NumericString): Uint8Array =>
  writeStringElement(tagHex, 'DS', String(value))

const PIXEL_DATA_TAG = 'x7fe00010'

/**
 * How `writeDicom` should emit Pixel Data (7FE0,0010).
 *
 * @remarks
 * `native` is the uncompressed layout every uncompressed transfer syntax uses:
 * one OB element whose value is the pixel payload. `encapsulated` is the
 * undefined-length layout every *compressed* syntax uses — an empty basic
 * offset table item, one item per fragment, then a sequence delimiter — which
 * is the shape a decode-debug view has to be able to report on. Byte counts
 * are padded up to even, as DICOM requires of every value length.
 */
type PixelDataFixture =
  | { readonly kind: 'native'; readonly byteLength: number }
  | { readonly kind: 'encapsulated'; readonly fragmentLengths: readonly number[] }

/** Round a DICOM value length up to the required even number of bytes. */
const evenLength = (length: number): number => length + (length % 2)

/** Write an encapsulation item header — `(FFFE,E000)` or `(FFFE,E0DD)` plus a 4-byte length. */
const writeItemHeader = (element: number, length: number): Uint8Array => {
  const bytes = new Uint8Array(8)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 0xfffe, true)
  view.setUint16(2, element, true)
  view.setUint32(4, length, true)
  return bytes
}

/**
 * Write the Pixel Data element for a {@link PixelDataFixture}. Payload bytes
 * are a fixed filler — nothing here decodes them, only measures them.
 */
const writePixelDataElement = (fixture: PixelDataFixture): Uint8Array => {
  if (fixture.kind === 'native') {
    const payload = new Uint8Array(evenLength(fixture.byteLength)).fill(0x7f)
    return writeElement(parseTag(PIXEL_DATA_TAG), 'OB', payload)
  }

  // OB with an undefined length (0xFFFFFFFF), which is what makes
  // `dicom-parser` treat what follows as encapsulation items.
  const header = new Uint8Array(12)
  const headerView = new DataView(header.buffer)
  headerView.setUint16(0, 0x7fe0, true)
  headerView.setUint16(2, 0x0010, true)
  header[4] = 0x4f // 'O'
  header[5] = 0x42 // 'B'
  headerView.setUint32(8, 0xffffffff, true)

  const parts: Uint8Array[] = [header, writeItemHeader(0xe000, 0)]
  for (const length of fixture.fragmentLengths) {
    const padded = evenLength(length)
    parts.push(writeItemHeader(0xe000, padded), new Uint8Array(padded).fill(0x7f))
  }
  parts.push(writeItemHeader(0xe0dd, 0))
  return concatArrays(parts)
}

/**
 * The {@link PixelDataDescription.Type} `DicomHeader.tryFromDicomFile` must
 * report for a fixture `writeDicom` emitted — an oracle derived from the
 * writer's byte layout, so a test can assert the parsed value whole.
 *
 * @remarks
 * The encapsulated `length` is what `dicom-parser` measures from the element's
 * data offset to the end of the sequence delimiter's header: the empty basic
 * offset table item (8 bytes), each fragment's item header plus its padded
 * bytes, and the delimiter's own 8-byte header.
 */
const describePixelDataFixture = (fixture: PixelDataFixture): PixelDataDescription.Type =>
  fixture.kind === 'native'
    ? {
        vr: 'OB',
        length: evenLength(fixture.byteLength),
        encapsulated: false,
        fragmentCount: undefined,
      }
    : {
        vr: 'OB',
        length:
          8 +
          fixture.fragmentLengths.reduce((total, length) => total + 8 + evenLength(length), 0) +
          8,
        encapsulated: true,
        fragmentCount: fixture.fragmentLengths.length,
      }

/** Write an empty SQ (sequence) element to signal presence. */
const writeSqElement = (tagHex: string): Uint8Array => {
  const tag = parseTag(tagHex)
  return writeElement(tag, 'SQ', new Uint8Array(0))
}

/** Format a PersonName as a DICOM PN value. */
const formatPersonName = (pn: PersonName.Type): string => {
  if (pn.family === '' && pn.given === '') return pn.text
  return pn.given === '' ? pn.family : `${pn.family}^${pn.given}`
}

/** A map of DICOM tag hex → value for `writeDicom`. */
type DicomTagMap = Partial<{
  // Patient
  PatientName: PersonName.Type
  PatientID: string
  IssuerOfPatientID: string
  PatientBirthDate: string
  PatientSex: string
  // Study
  StudyInstanceUID: string
  StudyDate: string
  StudyTime: string
  StudyDescription: string
  AccessionNumber: string
  ReferringPhysicianName: PersonName.Type
  RequestedProcedureDescription: string
  RequestAttributesSequence: true
  // Series
  SeriesInstanceUID: string
  SeriesNumber: NumericString
  SeriesDescription: string
  Modality: string
  BodyPartExamined: string
  // Instance
  SOPInstanceUID: string
  SOPClassUID: string
  InstanceNumber: NumericString
  Rows: number
  Columns: number
  NumberOfFrames: NumericString
  TransferSyntaxUID: string
  // Image Pixel
  SamplesPerPixel: number
  PhotometricInterpretation: string
  PlanarConfiguration: number
  BitsAllocated: number
  BitsStored: number
  HighBit: number
  PixelRepresentation: number
  WindowCenter: string
  WindowWidth: string
  RescaleIntercept: NumericString
  RescaleSlope: NumericString
  PixelData: PixelDataFixture
  // Equipment
  Manufacturer: string
  ManufacturerModelName: string
  InstitutionName: string
}>

/**
 * Build a minimal explicit-VR little-endian DICOM Part 10 file from a tag
 * map. Produces a 128-byte preamble + `DICM` + file meta group + dataset.
 *
 * @param tags - The tags to write. `StudyInstanceUID`, `SeriesInstanceUID`,
 *   and `SOPInstanceUID` are required by the parser; the rest are optional.
 */
const writeDicom = (tags: DicomTagMap): Uint8Array => {
  const elements: Uint8Array[] = []

  // File meta information group (group 0002)
  const metaElements: Uint8Array[] = []
  // Transfer Syntax UID (0002,0010). This writer always encodes the *dataset*
  // as Explicit VR Little Endian, which every encapsulated syntax also uses —
  // a compressed syntax changes only how Pixel Data is carried. So declaring
  // e.g. JPEG 2000 here alongside an encapsulated PixelData fixture produces a
  // genuinely well-formed file. Implicit VR (1.2.840.10008.1.2), Explicit VR
  // Big Endian and the deflated syntax would each need a different dataset
  // encoding, and this writer cannot produce them.
  metaElements.push(
    writeStringElement('x00020010', 'UI', tags.TransferSyntaxUID ?? '1.2.840.10008.1.2.1')
  )
  if (tags.SOPClassUID !== undefined) {
    metaElements.push(writeStringElement('x00020002', 'UI', tags.SOPClassUID))
  }

  // Calculate meta group length
  const metaBody = concatArrays(metaElements)
  const metaGroupLength = new Uint8Array(12)
  const metaView = new DataView(metaGroupLength.buffer)
  metaView.setUint16(0, 0x0002, true) // group
  metaView.setUint16(2, 0x0000, true) // element
  metaGroupLength[4] = 0x55 // 'U'
  metaGroupLength[5] = 0x4c // 'L'
  metaView.setUint16(6, 4, true) // length
  metaView.setUint32(8, metaBody.length, true)

  elements.push(metaGroupLength)
  elements.push(metaBody)

  // Dataset elements — must be in tag order
  const datasetElements: Array<{ tag: string; bytes: Uint8Array }> = []

  const addString = (tagHex: string, vr: string, value: string | undefined): void => {
    if (value !== undefined)
      datasetElements.push({ tag: tagHex, bytes: writeStringElement(tagHex, vr, value) })
  }
  const addPn = (tagHex: string, pn: PersonName.Type | undefined): void => {
    if (pn !== undefined)
      datasetElements.push({
        tag: tagHex,
        bytes: writeStringElement(tagHex, 'PN', formatPersonName(pn)),
      })
  }
  const addUs = (tagHex: string, value: number | undefined): void => {
    if (value !== undefined)
      datasetElements.push({ tag: tagHex, bytes: writeUsElement(tagHex, value) })
  }
  const addIs = (tagHex: string, value: NumericString | undefined): void => {
    if (value !== undefined)
      datasetElements.push({ tag: tagHex, bytes: writeIsElement(tagHex, value) })
  }
  const addDs = (tagHex: string, value: NumericString | undefined): void => {
    if (value !== undefined)
      datasetElements.push({ tag: tagHex, bytes: writeDsElement(tagHex, value) })
  }

  // SOP Class UID (0008,0016)
  addString('x00080016', 'UI', tags.SOPClassUID)
  // SOP Instance UID (0008,0018)
  addString('x00080018', 'UI', tags.SOPInstanceUID)
  // Study Date (0008,0020)
  addString('x00080020', 'DA', tags.StudyDate)
  // Study Time (0008,0030)
  addString('x00080030', 'TM', tags.StudyTime)
  // Accession Number (0008,0050)
  addString('x00080050', 'SH', tags.AccessionNumber)
  // Modality (0008,0060)
  addString('x00080060', 'CS', tags.Modality)
  // Manufacturer (0008,0070)
  addString('x00080070', 'LO', tags.Manufacturer)
  // Institution Name (0008,0080)
  addString('x00080080', 'LO', tags.InstitutionName)
  // Referring Physician Name (0008,0090)
  addPn('x00080090', tags.ReferringPhysicianName)
  // Study Description (0008,1030)
  addString('x00081030', 'LO', tags.StudyDescription)
  // Series Description (0008,103E)
  addString('x0008103e', 'LO', tags.SeriesDescription)
  // Manufacturer Model Name (0008,1090)
  addString('x00081090', 'LO', tags.ManufacturerModelName)
  // Patient Name (0010,0010)
  addPn('x00100010', tags.PatientName)
  // Patient ID (0010,0020)
  addString('x00100020', 'LO', tags.PatientID)
  // Issuer of Patient ID (0010,0021)
  addString('x00100021', 'LO', tags.IssuerOfPatientID)
  // Patient Birth Date (0010,0030)
  addString('x00100030', 'DA', tags.PatientBirthDate)
  // Patient Sex (0010,0040)
  addString('x00100040', 'CS', tags.PatientSex)
  // Body Part Examined (0018,0015)
  addString('x00180015', 'CS', tags.BodyPartExamined)
  // Study Instance UID (0020,000D)
  addString('x0020000d', 'UI', tags.StudyInstanceUID)
  // Series Instance UID (0020,000E)
  addString('x0020000e', 'UI', tags.SeriesInstanceUID)
  // Instance Number (0020,0013)
  addIs('x00200013', tags.InstanceNumber)
  // Series Number (0020,0011)
  addIs('x00200011', tags.SeriesNumber)
  // Samples per Pixel (0028,0002)
  addUs('x00280002', tags.SamplesPerPixel)
  // Photometric Interpretation (0028,0004)
  addString('x00280004', 'CS', tags.PhotometricInterpretation)
  // Planar Configuration (0028,0006)
  addUs('x00280006', tags.PlanarConfiguration)
  // Number of Frames (0028,0008)
  addIs('x00280008', tags.NumberOfFrames)
  // Rows (0028,0010)
  addUs('x00280010', tags.Rows)
  // Columns (0028,0011)
  addUs('x00280011', tags.Columns)
  // Bits Allocated (0028,0100)
  addUs('x00280100', tags.BitsAllocated)
  // Bits Stored (0028,0101)
  addUs('x00280101', tags.BitsStored)
  // High Bit (0028,0102)
  addUs('x00280102', tags.HighBit)
  // Pixel Representation (0028,0103)
  addUs('x00280103', tags.PixelRepresentation)
  // Window Center (0028,1050)
  addDs('x00281050', tags.WindowCenter)
  // Window Width (0028,1051)
  addDs('x00281051', tags.WindowWidth)
  // Rescale Intercept (0028,1052)
  addDs('x00281052', tags.RescaleIntercept)
  // Rescale Slope (0028,1053)
  addDs('x00281053', tags.RescaleSlope)
  // Requested Procedure Description (0032,1060)
  addString('x00321060', 'LO', tags.RequestedProcedureDescription)
  // Request Attributes Sequence (0040,0275)
  if (tags.RequestAttributesSequence === true) {
    datasetElements.push({ tag: 'x00400275', bytes: writeSqElement('x00400275') })
  }
  // Pixel Data (7FE0,0010) — last by tag, which is also where it has to sit:
  // an undefined-length element runs until its sequence delimiter, so anything
  // written after it would be read as one of its fragments.
  if (tags.PixelData !== undefined) {
    datasetElements.push({
      tag: PIXEL_DATA_TAG,
      bytes: writePixelDataElement(tags.PixelData),
    })
  }

  // Sort by tag to ensure proper DICOM ordering
  datasetElements.sort((a, b) => a.tag.localeCompare(b.tag))
  for (const el of datasetElements) elements.push(el.bytes)

  // Build the final file: 128-byte preamble + "DICM" + elements
  const body = concatArrays(elements)
  const file = new Uint8Array(132 + body.length)
  // 128-byte preamble (zeros)
  // "DICM" magic
  file[128] = 0x44 // D
  file[129] = 0x49 // I
  file[130] = 0x43 // C
  file[131] = 0x4d // M
  file.set(body, 132)
  return file
}

const concatArrays = (arrays: Uint8Array[]): Uint8Array => {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

// ---------------------------------------------------------------------------
// fast-check arbitraries
// ---------------------------------------------------------------------------

const dicomUidArb = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.constantFrom('1.2.840.10008', '1.2.826.0.1', '1.3.6.1.4.1'),
      fc.array(fc.integer({ min: 0, max: 99999 }), { minLength: 2, maxLength: 5 })
    )
    .map(([prefix, components]) => `${prefix}.${components.join('.')}`)
    .filter((uid) => uid.length <= 64)

const dicomDateArb = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.integer({ min: 1990, max: 2030 }),
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 1, max: 28 })
    )
    .map(([y, m, d]) => `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`)

const dicomTimeArb = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.integer({ min: 0, max: 23 }),
      fc.integer({ min: 0, max: 59 }),
      fc.integer({ min: 0, max: 59 })
    )
    .map(
      ([h, m, s]) =>
        `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}${String(s).padStart(2, '0')}`
    )

const personNameArb = (): fc.Arbitrary<PersonName.Type> =>
  fc
    .tuple(
      fc.string({
        minLength: 1,
        maxLength: 20,
        unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '.split('')),
      }),
      fc.string({
        minLength: 0,
        maxLength: 20,
        unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '.split('')),
      })
    )
    .map(([family, given]): PersonName.Type => {
      const f = family.trim() || 'Doe'
      const g = given.trim()
      const text = g === '' ? f : `${f} ${g}`
      return { family: f, given: g, text }
    })

/** A non-empty, non-whitespace-only string — matches what `readString` returns after trimming. */
const dicomTextArb = (maxLength: number): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.string({
        minLength: 1,
        maxLength: 1,
        unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
      }),
      fc.string({
        minLength: 0,
        maxLength: maxLength - 1,
        unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '.split('')),
      })
    )
    .map(([first, rest]) => (first + rest).trimEnd())

/**
 * Fragment byte lengths for an encapsulated Pixel Data fixture — at least one
 * fragment, since an encapsulated element with none carries no frames.
 */
const pixelDataFragmentLengthsArb = (): fc.Arbitrary<readonly number[]> =>
  fc.array(fc.integer({ min: 0, max: 4096 }), { minLength: 1, maxLength: 8 })

/**
 * A native (uncompressed) Pixel Data fixture.
 *
 * @remarks
 * Encapsulated fixtures are deliberately absent here. {@link headerToTagMap}
 * has to turn a parsed {@link PixelDataDescription.Type} back into the fixture
 * that produced it, and an encapsulated element's `length` folds every
 * fragment's size into one total that no longer says how the fragments were
 * split. The encapsulated layout is covered directly, over
 * {@link pixelDataFragmentLengthsArb}, in `dicom-header.test.ts`.
 */
const nativePixelDataArb = (): fc.Arbitrary<PixelDataFixture> =>
  fc
    .integer({ min: 0, max: 8192 })
    .map((byteLength): PixelDataFixture => ({ kind: 'native', byteLength: evenLength(byteLength) }))

const dicomHeaderArb = (): fc.Arbitrary<DicomHeader.Type> =>
  fc.record({
    patientName: fc.option(personNameArb(), { nil: undefined }),
    patientId: fc.option(
      fc.string({
        minLength: 1,
        maxLength: 20,
        unit: fc.constantFrom(...'0123456789ABCDEF'.split('')),
      }),
      { nil: undefined }
    ),
    issuerOfPatientId: fc.option(
      fc.string({
        minLength: 1,
        maxLength: 30,
        unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
      }),
      { nil: undefined }
    ),
    patientBirthDate: fc.option(dicomDateArb(), { nil: undefined }),
    patientSex: fc.option(fc.constantFrom('M', 'F', 'O'), { nil: undefined }),

    studyInstanceUid: dicomUidArb(),
    studyDate: fc.option(dicomDateArb(), { nil: undefined }),
    studyTime: fc.option(dicomTimeArb(), { nil: undefined }),
    studyDescription: fc.option(dicomTextArb(40), { nil: undefined }),
    accessionNumber: fc.option(
      fc.string({ minLength: 1, maxLength: 16, unit: fc.constantFrom(...'0123456789'.split('')) }),
      { nil: undefined }
    ),
    referringPhysicianName: fc.option(personNameArb(), { nil: undefined }),
    requestedProcedureDescription: fc.option(dicomTextArb(40), { nil: undefined }),
    hasRequestAttributesSequence: fc.boolean(),

    seriesInstanceUid: dicomUidArb(),
    seriesNumber: fc.option(fc.integer({ min: 1, max: 999 }), { nil: undefined }),
    seriesDescription: fc.option(dicomTextArb(40), { nil: undefined }),
    modality: fc.option(
      fc.constantFrom('CT', 'MR', 'US', 'CR', 'DX', 'XA', 'NM', 'PT', 'MG', 'OT'),
      { nil: undefined }
    ),
    bodyPartExamined: fc.option(
      fc.constantFrom('CHEST', 'HEAD', 'ABDOMEN', 'SPINE', 'KNEE', 'HAND', 'PELVIS'),
      { nil: undefined }
    ),

    sopInstanceUid: dicomUidArb(),
    sopClassUid: fc.option(dicomUidArb(), { nil: undefined }),
    instanceNumber: fc.option(fc.integer({ min: 1, max: 999 }), { nil: undefined }),
    rows: fc.option(fc.integer({ min: 64, max: 4096 }), { nil: undefined }),
    columns: fc.option(fc.integer({ min: 64, max: 4096 }), { nil: undefined }),
    numberOfFrames: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
    // Never absent: writeDicom always emits (0002,0010), so a header claiming
    // no transfer syntax could not round-trip. The values are the ones whose
    // *dataset* is Explicit VR Little Endian, which is all this writer emits —
    // see the Transfer Syntax UID comment in `writeDicom`.
    transferSyntaxUid: fc.constantFrom(
      '1.2.840.10008.1.2.1',
      '1.2.840.10008.1.2.4.50',
      '1.2.840.10008.1.2.4.90',
      '1.2.840.10008.1.2.5'
    ),

    samplesPerPixel: fc.option(fc.constantFrom(1, 3), { nil: undefined }),
    photometricInterpretation: fc.option(
      fc.constantFrom('MONOCHROME1', 'MONOCHROME2', 'RGB', 'PALETTE COLOR', 'YBR_FULL_422'),
      { nil: undefined }
    ),
    planarConfiguration: fc.option(fc.constantFrom(0, 1), { nil: undefined }),
    bitsAllocated: fc.option(fc.constantFrom(8, 16, 32), { nil: undefined }),
    bitsStored: fc.option(fc.integer({ min: 1, max: 32 }), { nil: undefined }),
    highBit: fc.option(fc.integer({ min: 0, max: 31 }), { nil: undefined }),
    pixelRepresentation: fc.option(fc.constantFrom(0, 1), { nil: undefined }),
    // DS is a decimal string, so only values whose `String(...)` form parses
    // back identically round-trip. Integers and halves do; 0.1 + 0.2 does not.
    rescaleIntercept: fc.option(fc.integer({ min: -4096, max: 4096 }), { nil: undefined }),
    rescaleSlope: fc.option(fc.constantFrom(0.5, 1, 2, 2.5), { nil: undefined }),
    // Read back as the raw DS string, multi-valued presets included.
    windowCenter: fc.option(fc.constantFrom('40', '-600', '40\\300'), { nil: undefined }),
    windowWidth: fc.option(fc.constantFrom('400', '1500', '400\\600'), { nil: undefined }),
    pixelData: fc.option(nativePixelDataArb().map(describePixelDataFixture), { nil: undefined }),

    manufacturer: fc.option(
      fc.constantFrom('GE MEDICAL SYSTEMS', 'SIEMENS', 'Philips', 'FUJIFILM'),
      { nil: undefined }
    ),
    manufacturerModelName: fc.option(dicomTextArb(20), { nil: undefined }),
    institutionName: fc.option(dicomTextArb(30), { nil: undefined }),

    // `writeDicom` emits well-formed files, so there is nothing for
    // `dicom-parser` to warn about. A file that does warn is malformed in a
    // way this writer cannot express.
    parserWarnings: fc.constant([]),
  })

/**
 * The fixture that would produce `description`.
 *
 * @remarks
 * Only the native layout inverts: an encapsulated element's `length` is one
 * total across every fragment and both item headers, so the split that made it
 * is not recoverable. Rather than quietly writing a native element for an
 * encapsulated description — a fixture that no longer matches what the caller
 * asked for — this throws, and encapsulated cases build their fixture directly.
 */
const pixelDataFixtureFrom = (
  description: PixelDataDescription.Type | undefined
): PixelDataFixture | undefined => {
  if (description === undefined) return undefined
  if (description.encapsulated) {
    throw new Error(
      'headerToTagMap cannot invert an encapsulated PixelDataDescription — ' +
        'build a { kind: "encapsulated", fragmentLengths } fixture directly'
    )
  }
  return { kind: 'native', byteLength: description.length }
}

/** Build a `DicomTagMap` from a `DicomHeader` for round-trip testing. */
const headerToTagMap = (header: DicomHeader.Type): DicomTagMap => ({
  PatientName: header.patientName ?? undefined,
  PatientID: header.patientId,
  IssuerOfPatientID: header.issuerOfPatientId,
  PatientBirthDate: header.patientBirthDate,
  PatientSex: header.patientSex,
  StudyInstanceUID: header.studyInstanceUid,
  StudyDate: header.studyDate,
  StudyTime: header.studyTime,
  StudyDescription: header.studyDescription,
  AccessionNumber: header.accessionNumber,
  ReferringPhysicianName: header.referringPhysicianName ?? undefined,
  RequestedProcedureDescription: header.requestedProcedureDescription,
  RequestAttributesSequence: header.hasRequestAttributesSequence ? true : undefined,
  SeriesInstanceUID: header.seriesInstanceUid,
  SeriesNumber: header.seriesNumber,
  SeriesDescription: header.seriesDescription,
  Modality: header.modality,
  BodyPartExamined: header.bodyPartExamined,
  SOPInstanceUID: header.sopInstanceUid,
  SOPClassUID: header.sopClassUid,
  InstanceNumber: header.instanceNumber,
  Rows: header.rows,
  Columns: header.columns,
  NumberOfFrames: header.numberOfFrames,
  TransferSyntaxUID: header.transferSyntaxUid,
  SamplesPerPixel: header.samplesPerPixel,
  PhotometricInterpretation: header.photometricInterpretation,
  PlanarConfiguration: header.planarConfiguration,
  BitsAllocated: header.bitsAllocated,
  BitsStored: header.bitsStored,
  HighBit: header.highBit,
  PixelRepresentation: header.pixelRepresentation,
  WindowCenter: header.windowCenter,
  WindowWidth: header.windowWidth,
  RescaleIntercept: header.rescaleIntercept,
  RescaleSlope: header.rescaleSlope,
  PixelData: pixelDataFixtureFrom(header.pixelData),
  Manufacturer: header.manufacturer,
  ManufacturerModelName: header.manufacturerModelName,
  InstitutionName: header.institutionName,
})

// ---------------------------------------------------------------------------
// Study fixtures — one coherent study across several files
// ---------------------------------------------------------------------------

/** One file of a generated study: the name it is picked under, and its tags. */
interface StudyFileFixture {
  readonly fileName: string
  readonly tags: DicomTagMap
}

/**
 * A coherent DICOM study spread across several files, with the facts a test
 * asserts against stated alongside the files themselves.
 *
 * @remarks
 * A study is not a bag of independent headers: every file of it repeats the
 * same `StudyInstanceUID`, patient and accession, and states one instance of
 * one series. Reconstructing those invariants in each test is what a shared
 * fixture exists to prevent — and the stated counts and orders are the oracle
 * a property checks the synthesis against, so a test never re-derives from the
 * tags what the generator already knows.
 */
interface StudyFixture {
  readonly studyInstanceUid: string
  readonly patientId: string
  readonly accessionNumber: string | undefined
  /** The study's series UIDs in `SeriesNumber` order — the order the synthesis must produce. */
  readonly seriesUidsInOrder: readonly string[]
  /** Every `SOPInstanceUID` in study order: series by series, `InstanceNumber` within each. */
  readonly instanceUidsInOrder: readonly string[]
  /** The files, one per instance, in no particular order. */
  readonly files: readonly StudyFileFixture[]
}

/** Options for {@link dicomStudyArb}. */
interface StudyArbOptions {
  /** How many series the study has. Defaults to 1–3. */
  readonly seriesCount?: { readonly min?: number; readonly max?: number }
  /** How many instances each series has. Defaults to 1–4. */
  readonly instancesPerSeries?: { readonly min?: number; readonly max?: number }
}

/**
 * Numbers `1..count` in some order — what a series' `SeriesNumber`s and an
 * instance's `InstanceNumber`s are drawn from.
 *
 * @remarks
 * A *permutation*, not the identity, on purpose: UIDs are generated in index
 * order, so numbering in index order too would make "ordered by number" and
 * "ordered by UID" the same sequence, and a synthesis that ordered by the
 * wrong one would pass. Shuffling them separates the two.
 */
const numberingArb = (count: number): fc.Arbitrary<readonly number[]> =>
  fc.shuffledSubarray(
    Array.from({ length: count }, (_, index) => index + 1),
    { minLength: count, maxLength: count }
  )

const rangeOr = (
  range: { readonly min?: number; readonly max?: number } | undefined,
  fallback: { readonly min: number; readonly max: number }
): { readonly min: number; readonly max: number } => ({
  min: range?.min ?? fallback.min,
  max: range?.max ?? fallback.max,
})

/**
 * A study of N files: one `StudyInstanceUID`, one patient, several series, and
 * one file per instance.
 *
 * @param options - How many series, and how many instances per series
 * @returns The study's files and the ordering oracle {@link StudyFixture}
 *   states
 */
const dicomStudyArb = (options: StudyArbOptions = {}): fc.Arbitrary<StudyFixture> => {
  const series = rangeOr(options.seriesCount, { min: 1, max: 3 })
  const instances = rangeOr(options.instancesPerSeries, { min: 1, max: 4 })
  return fc
    .record({
      root: fc.integer({ min: 1, max: 99999 }),
      patientId: fc.string({
        minLength: 1,
        maxLength: 8,
        unit: fc.constantFrom(...'0123456789ABCDEF'.split('')),
      }),
      patientName: personNameArb(),
      studyDate: dicomDateArb(),
      studyTime: dicomTimeArb(),
      accessionNumber: fc.option(
        fc.string({ minLength: 1, maxLength: 8, unit: fc.constantFrom(...'0123456789'.split('')) }),
        { nil: undefined }
      ),
      modality: fc.constantFrom('CT', 'MR', 'US', 'PT'),
      seriesCount: fc.integer(series),
      instanceCounts: fc.array(fc.integer(instances), {
        minLength: series.max,
        maxLength: series.max,
      }),
    })
    .chain((base) => {
      const counts = base.instanceCounts.slice(0, base.seriesCount)
      return fc
        .record({
          seriesNumbers: numberingArb(base.seriesCount),
          instanceNumbers: fc.tuple(...counts.map((count) => numberingArb(count))),
        })
        .map(({ seriesNumbers, instanceNumbers }): StudyFixture => {
          const studyInstanceUid = `1.2.826.0.1.${base.root}`
          const seriesOf = counts.map((count, index) => ({
            uid: `${studyInstanceUid}.${index + 1}`,
            number: seriesNumbers[index],
            instances: Array.from({ length: count }, (_, instanceIndex) => ({
              uid: `${studyInstanceUid}.${index + 1}.${instanceIndex + 1}`,
              number: instanceNumbers[index][instanceIndex],
            })),
          }))
          const inStudyOrder = seriesOf
            .toSorted((left, right) => left.number - right.number)
            .map((one) => ({
              ...one,
              instances: one.instances.toSorted((left, right) => left.number - right.number),
            }))

          const files = seriesOf.flatMap((one) =>
            one.instances.map((instance): StudyFileFixture => ({
              fileName: `${instance.uid}.dcm`,
              tags: {
                StudyInstanceUID: studyInstanceUid,
                SeriesInstanceUID: one.uid,
                SeriesNumber: one.number,
                SOPInstanceUID: instance.uid,
                InstanceNumber: instance.number,
                PatientID: base.patientId,
                PatientName: base.patientName,
                StudyDate: base.studyDate,
                StudyTime: base.studyTime,
                Modality: base.modality,
                ...(base.accessionNumber === undefined
                  ? {}
                  : { AccessionNumber: base.accessionNumber }),
              },
            }))
          )

          return {
            studyInstanceUid,
            patientId: base.patientId,
            accessionNumber: base.accessionNumber,
            seriesUidsInOrder: inStudyOrder.map((one) => one.uid),
            instanceUidsInOrder: inStudyOrder.flatMap((one) =>
              one.instances.map((instance) => instance.uid)
            ),
            files,
          }
        })
    })
}

/** A study fixture's files as named bytes, ready to pick. */
const writeStudy = (
  fixture: StudyFixture
): readonly { readonly fileName: string; readonly bytes: Uint8Array }[] =>
  fixture.files.map((file) => ({ fileName: file.fileName, bytes: writeDicom(file.tags) }))

export {
  describePixelDataFixture,
  dicomDateArb,
  dicomStudyArb,
  dicomHeaderArb,
  dicomTimeArb,
  dicomUidArb,
  type DicomTagMap,
  formatPersonName,
  headerToTagMap,
  nativePixelDataArb,
  personNameArb,
  type PixelDataFixture,
  pixelDataFragmentLengthsArb,
  writeDicom,
  writeStudy,
}
export type { StudyArbOptions, StudyFileFixture, StudyFixture }
