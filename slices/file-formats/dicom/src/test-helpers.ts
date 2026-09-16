/**
 * Test-only DICOM Part 10 writer and fast-check arbitraries for
 * {@link DicomHeader}. Every DICOM test in the repo synthesizes fixtures
 * from these helpers; no `.dcm` files are committed.
 *
 * @packageDocumentation
 */
import * as fc from 'fast-check'

import type { DicomHeader, PersonName } from './dicom-header.ts'

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

/** Write an IS (integer string) element. */
const writeIsElement = (tagHex: string, value: number): Uint8Array =>
  writeStringElement(tagHex, 'IS', String(value))

/** Write an empty SQ (sequence) element to signal presence. */
const writeSqElement = (tagHex: string): Uint8Array => {
  const tag = parseTag(tagHex)
  return writeElement(tag, 'SQ', new Uint8Array(0))
}

/** Format a PersonName as a DICOM PN value. */
const formatPersonName = (pn: PersonName): string => {
  if (pn.family === '' && pn.given === '') return pn.text
  return pn.given === '' ? pn.family : `${pn.family}^${pn.given}`
}

/** A map of DICOM tag hex → value for `writeDicom`. */
type DicomTagMap = Partial<{
  // Patient
  PatientName: PersonName
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
  ReferringPhysicianName: PersonName
  RequestedProcedureDescription: string
  RequestAttributesSequence: true
  // Series
  SeriesInstanceUID: string
  SeriesNumber: number
  SeriesDescription: string
  Modality: string
  BodyPartExamined: string
  // Instance
  SOPInstanceUID: string
  SOPClassUID: string
  InstanceNumber: number
  Rows: number
  Columns: number
  NumberOfFrames: number
  TransferSyntaxUID: string
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
  // Transfer Syntax UID in the file meta always says Explicit VR Little
  // Endian — that is how this writer encodes the dataset. The header's
  // TransferSyntaxUID field (0002,0010) is read back by the parser from
  // this position, so it round-trips the value we write here.
  metaElements.push(writeStringElement('x00020010', 'UI', '1.2.840.10008.1.2.1'))
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
  const addPn = (tagHex: string, pn: PersonName | undefined): void => {
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
  const addIs = (tagHex: string, value: number | undefined): void => {
    if (value !== undefined)
      datasetElements.push({ tag: tagHex, bytes: writeIsElement(tagHex, value) })
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
  // Number of Frames (0028,0008)
  addIs('x00280008', tags.NumberOfFrames)
  // Rows (0028,0010)
  addUs('x00280010', tags.Rows)
  // Columns (0028,0011)
  addUs('x00280011', tags.Columns)
  // Requested Procedure Description (0032,1060)
  addString('x00321060', 'LO', tags.RequestedProcedureDescription)
  // Request Attributes Sequence (0040,0275)
  if (tags.RequestAttributesSequence === true) {
    datasetElements.push({ tag: 'x00400275', bytes: writeSqElement('x00400275') })
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

const personNameArb = (): fc.Arbitrary<PersonName> =>
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
    .map(([family, given]): PersonName => {
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

const dicomHeaderArb = (): fc.Arbitrary<DicomHeader> =>
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
    // writeDicom always encodes as Explicit VR Little Endian — the file
    // meta's Transfer Syntax UID is always 1.2.840.10008.1.2.1 and that is
    // what parseDicomFile reads back. The arbitrary is fixed to that value
    // so the round-trip holds; other transfer syntaxes would require a
    // different writer.
    transferSyntaxUid: fc.option(fc.constant('1.2.840.10008.1.2.1'), { nil: undefined }),

    manufacturer: fc.option(
      fc.constantFrom('GE MEDICAL SYSTEMS', 'SIEMENS', 'Philips', 'FUJIFILM'),
      { nil: undefined }
    ),
    manufacturerModelName: fc.option(dicomTextArb(20), { nil: undefined }),
    institutionName: fc.option(dicomTextArb(30), { nil: undefined }),
  })

/** Build a `DicomTagMap` from a `DicomHeader` for round-trip testing. */
const headerToTagMap = (header: DicomHeader): DicomTagMap => ({
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
  Manufacturer: header.manufacturer,
  ManufacturerModelName: header.manufacturerModelName,
  InstitutionName: header.institutionName,
})

export {
  dicomDateArb,
  dicomHeaderArb,
  dicomTimeArb,
  dicomUidArb,
  type DicomTagMap,
  formatPersonName,
  headerToTagMap,
  personNameArb,
  writeDicom,
}
