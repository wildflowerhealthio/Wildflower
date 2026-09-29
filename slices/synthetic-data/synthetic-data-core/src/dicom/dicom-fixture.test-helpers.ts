import { parseDicom, type DataSet } from 'dicom-parser'
import { type DicomTagMap, dicomHeaderArb, headerToTagMap, writeDicom } from 'dicom/test-helpers'
import * as fc from 'fast-check'

import * as Part10 from './part10.ts'

/**
 * De-identified DICOM fixtures for the re-identification tests: a
 * `writeDicom` file with the elements a de-identified export carries and
 * `writeDicom` cannot write — private groups, the de-identification
 * attributes, extra dates, a Frame of Reference — spliced in at their place in
 * tag order.
 *
 * @remarks
 * Splicing is located with `dicom-parser`, not with the module under test, so
 * a fixture does not depend on the reader it is fed to (only on
 * `Part10.concat`, to join the bytes).
 */

/** One element written by hand: tag, VR and the value's text, or bytes for a sequence. */
interface ExtraElement {
  readonly tag: number
  readonly vr: string
  readonly value: string | Uint8Array
  readonly undefinedLength?: boolean
}

const LONG_VRS = new Set([
  'OB',
  'OD',
  'OF',
  'OL',
  'OV',
  'OW',
  'SQ',
  'SV',
  'UC',
  'UN',
  'UR',
  'UT',
  'UV',
])

/** An Explicit VR Little Endian element's bytes, a text value padded to even length. */
const elementBytesOf = (element: ExtraElement): Uint8Array => {
  const raw =
    typeof element.value === 'string' ? new TextEncoder().encode(element.value) : element.value
  const value = new Uint8Array(raw.length + (raw.length % 2))
  value.set(raw)
  if (raw.length % 2 === 1) value[raw.length] = element.vr === 'UI' ? 0 : 0x20
  const long = LONG_VRS.has(element.vr)
  const header = long ? 12 : 8
  const bytes = new Uint8Array(header + value.length)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, element.tag >>> 16, true)
  view.setUint16(2, element.tag & 0xffff, true)
  bytes[4] = element.vr.charCodeAt(0)
  bytes[5] = element.vr.charCodeAt(1)
  const length = element.undefinedLength === true ? 0xffff_ffff : value.length
  if (long) view.setUint32(8, length, true)
  else view.setUint16(6, length, true)
  bytes.set(value, header)
  return bytes
}

/** `xGGGGEEEE` — `dicom-parser`'s key for a tag. */
const parserKeyOf = (tag: number): string => `x${tag.toString(16).padStart(8, '0')}`

/** Where a top-level element's header starts, from `dicom-parser`'s value offset. */
const headerStartOf = (dataSet: DataSet, key: string): number => {
  const element = dataSet.elements[key]
  if (element === undefined) throw new Error(`no element ${key}`)
  const vr = element.vr ?? ''
  return element.dataOffset - (LONG_VRS.has(vr) ? 12 : 8)
}

/** `file` with `extras` inserted before the first data set element whose tag follows each. */
const withElementsSpliced = (file: Uint8Array, extras: readonly ExtraElement[]): Uint8Array => {
  const dataSet = parseDicom(file)
  const existing = Object.keys(dataSet.elements)
    .filter((key) => !key.startsWith('x0002'))
    .map((key) => ({ tag: Number.parseInt(key.slice(1), 16), start: headerStartOf(dataSet, key) }))
    .toSorted((left, right) => left.tag - right.tag)
  const insertions = extras
    .map((extra) => ({
      at: existing.find((element) => element.tag > extra.tag)?.start ?? file.length,
      tag: extra.tag,
      bytes: elementBytesOf(extra),
    }))
    .toSorted((left, right) => left.at - right.at || left.tag - right.tag)
  const parts: Uint8Array[] = []
  let from = 0
  for (const insertion of insertions) {
    parts.push(file.slice(from, insertion.at), insertion.bytes)
    from = insertion.at
  }
  parts.push(file.slice(from))
  return Part10.concat(parts)
}

const SOURCE_FRAME_OF_REFERENCE_UID = '1.3.6.1.4.1.14519.5.2.1.99.2'

/**
 * What a de-identified export adds to a `writeDicom` file: private groups
 * `0009` and `0013`, the de-identification attributes, an `ImageType`, dates
 * no re-identification writes (an overlay date, a last menstrual date), an
 * `AcquisitionDateTime`, a `PatientAge` and a Frame of Reference UID.
 */
const DEIDENTIFIED_EXPORT_ELEMENTS: readonly ExtraElement[] = [
  { tag: 0x0008_0008, vr: 'CS', value: 'ORIGINAL\\PRIMARY\\AXIAL' },
  { tag: 0x0008_0024, vr: 'DA', value: '20000101' },
  { tag: 0x0008_002a, vr: 'DT', value: '20000101' },
  { tag: 0x0009_0010, vr: 'LO', value: 'ACME PRIVATE' },
  { tag: 0x0009_1001, vr: 'LO', value: 'site-internal-id-4471' },
  { tag: 0x0010_1010, vr: 'AS', value: '061Y' },
  { tag: 0x0010_21d0, vr: 'DA', value: '20000101' },
  { tag: 0x0012_0062, vr: 'CS', value: 'YES' },
  { tag: 0x0012_0063, vr: 'LO', value: 'DCM:113100/113105' },
  { tag: 0x0013_0010, vr: 'LO', value: 'CTP' },
  { tag: 0x0013_1010, vr: 'LO', value: 'COLLECTION-0002' },
  { tag: 0x0020_0052, vr: 'UI', value: SOURCE_FRAME_OF_REFERENCE_UID },
]

/** The private elements {@link DEIDENTIFIED_EXPORT_ELEMENTS} adds. */
const PRIVATE_TAGS = DEIDENTIFIED_EXPORT_ELEMENTS.map((element) => element.tag).filter(
  (tag) => (tag >>> 16) % 2 === 1
)

/**
 * A de-identified source file's tags: a generated header, as Explicit VR
 * Little Endian, always with native Pixel Data.
 */
const deidentifiedTagsArbitrary: fc.Arbitrary<DicomTagMap> = fc
  .tuple(dicomHeaderArb(), fc.integer({ min: 2, max: 4096 }))
  .map(([header, pixelBytes]) => ({
    ...headerToTagMap(header),
    TransferSyntaxUID: '1.2.840.10008.1.2.1',
    PixelData: { kind: 'native', byteLength: pixelBytes + (pixelBytes % 2) },
  }))

/** A de-identified source file: {@link deidentifiedTagsArbitrary} with the export's own elements. */
const deidentifiedFileArbitrary: fc.Arbitrary<Uint8Array> = deidentifiedTagsArbitrary.map((tags) =>
  withElementsSpliced(writeDicom(tags), DEIDENTIFIED_EXPORT_ELEMENTS)
)

/** A top-level element's value bytes, as `dicom-parser` locates them. */
const valueBytesOf = (dataSet: DataSet, tag: number): Uint8Array | undefined => {
  const element = dataSet.elements[parserKeyOf(tag)]
  return element === undefined
    ? undefined
    : dataSet.byteArray.slice(element.dataOffset, element.dataOffset + element.length)
}

/** A top-level element's whole value as text — every value, backslashes kept — padding trimmed. */
const textOf = (dataSet: DataSet, tag: number): string | undefined => {
  const bytes = valueBytesOf(dataSet, tag)
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes).replace(/[\0 ]+$/, '')
}

export {
  DEIDENTIFIED_EXPORT_ELEMENTS,
  deidentifiedFileArbitrary,
  deidentifiedTagsArbitrary,
  elementBytesOf,
  parserKeyOf,
  PRIVATE_TAGS,
  SOURCE_FRAME_OF_REFERENCE_UID,
  textOf,
  valueBytesOf,
  withElementsSpliced,
}
export type { ExtraElement }
